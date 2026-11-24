import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { repoPath } from "./lib/repo-root.mjs";
import { makeTempDir } from "./lib/tmp.mjs";

const helperPath = repoPath(".devpro/scripts/hooks/lib/second-review-control-evidence.mjs");

function helperSource() {
  assert.equal(
    existsSync(helperPath),
    true,
    "runtime must provide the durable second-review control-evidence helper"
  );
  return readFileSync(helperPath, "utf8");
}

async function loadHelper() {
  helperSource();
  return import(`${pathToFileURL(helperPath).href}?red-contract=${Date.now()}`);
}

function withTempDir(fn) {
  const dir = makeTempDir("second-review-control-evidence-");
  const previousMarkerRoot = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = path.join(dir, ".markers");
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => {
      if (previousMarkerRoot === undefined) delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
      else process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = previousMarkerRoot;
      rmSync(dir, { recursive: true, force: true });
    });
}

async function reserveWithMarkerWitness(helper, rootDir, record) {
  const predecessor = helper.readDispatchEvidence({ rootDir, dispatchId: record.previous_dispatch_id }).dispatch;
  const state = await import("../hooks/lib/post-pr-completion-state.mjs");
  const file = state.writePostPrCompletionMarker({ cwd: rootDir, prNumber: record.pr_number,
    repositorySlug: record.repository_slug, headRefOid: predecessor.head_ref_oid,
    expectedDispatchId: predecessor.dispatch_id, sessionId: "" });
  const bytes = readFileSync(file), snapshot = JSON.parse(bytes.toString("utf8"));
  const result = await helper.reserveDispatchRecord({ rootDir, record,
    predecessorMarker: { file, snapshot, sha256: createHash("sha256").update(bytes).digest("hex") } });
  // The helper-level fixture models a completed transition; later cleanup tests explicitly add active markers.
  rmSync(file);
  return result;
}

const CANONICAL_HEAD_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MIXED_CASE_HEAD_SHA = "AaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
const AUDIT_COMPLETION_FIELDS = Object.freeze([
  "schema",
  "repository_slug",
  "pr_number",
  "head_ref_oid",
  "attempt_id",
  "dispatch_id",
  "previous_dispatch_id",
  "outcome",
  "classification",
  "process_close_observed",
  "integrity_id",
]);

function dispatchRecord(overrides = {}) {
  return {
    schema: "devpro-second-review-dispatch/v1",
    repository_slug: "devpro/example",
    pr_number: "1658",
    head_ref_oid: "abc123",
    attempt_id: "second-review-pr-1658-abc123-initial",
    dispatch_id: "dispatch-1658-current",
    previous_dispatch_id: null,
    packet_sha256: "a".repeat(64),
    carrier_root_id: "b".repeat(64),
    ...overrides,
  };
}

const PR2927_UNSTARTED_CONFIRMATION = "ABANDON dispatch-791fa840-4c9a-41f5-b376-93bfd20ad602 head 1ca5d65c55dcb15f5395c201d413ce4a164ef327 runner_not_started";

function pr2927UnstartedDispatchRecord(overrides = {}) {
  return {
    schema: "devpro-second-review-dispatch/v1",
    repository_slug: "devpro-tw/devpro-agent-rules",
    pr_number: "2927",
    head_ref_oid: "1ca5d65c55dcb15f5395c201d413ce4a164ef327",
    attempt_id: "second-review-pr-2927-1ca5d65c55dc-initial-56293eef-eb39-4583-93bc-d20a75e8c846",
    dispatch_id: "dispatch-791fa840-4c9a-41f5-b376-93bfd20ad602",
    previous_dispatch_id: "dispatch-79f1b681-bca6-41c8-bd79-e129b1458be3",
    packet_sha256: "dad31c833d7e6a67e74707b2cd95f6f985b22f420fb1375dcdab590be0317ce2",
    carrier_root_id: "7c9f58f723990df388ca9932e1460633698f616dc5559ec47b425fe10ec6c244",
    paged_full_material_sha256: "4a684cd5f268f7124a7501b79cb3f36a5a34f78131838b3e45a71fa92274d8a3",
    paged_full_material_created_at: "2026-09-30T09:47:51.779Z",
    paged_full_material_expires_at: "2026-09-30T11:47:51.779Z",
    ...overrides,
  };
}

function pr2927OperatorAuthorization(overrides = {}) {
  return {
    operator_login: "allenchan",
    repository_permissions_push: true,
    permission_source: "gh-api-repository",
    target_repository: "devpro-tw/devpro-agent-rules",
    pr_number: "2927",
    pr_state: "OPEN",
    pr_merged: false,
    base_repository: "devpro-tw/devpro-agent-rules",
    head_repository: "devpro-tw/devpro-agent-rules",
    head_ref: "bugfix/fix-post-pr-marker-non-ff-rebind",
    remote_pr_head: "1ca5d65c55dcb15f5395c201d413ce4a164ef327",
    local_repository: "devpro-tw/devpro-agent-rules",
    local_branch: "bugfix/fix-post-pr-marker-non-ff-rebind",
    local_implementation_commit: "b".repeat(40),
    authorization_checked_at: "2026-09-30T12:00:00.000Z",
    ...overrides,
  };
}

function pr2927OperatorSlotRecord(dispatch, authorization = pr2927OperatorAuthorization(), overrides = {}) {
  return withIntegrity({
    schema: "devpro-second-review-operator-abandonment/v1",
    repository_slug: dispatch.repository_slug,
    pr_number: dispatch.pr_number,
    head_ref_oid: dispatch.head_ref_oid,
    attempt_id: dispatch.attempt_id,
    dispatch_id: dispatch.dispatch_id,
    previous_dispatch_id: dispatch.previous_dispatch_id,
    ...authorization,
    typed_confirmation: PR2927_UNSTARTED_CONFIRMATION,
    runner_not_started: true,
    created_at: "2026-09-30T12:01:00.000Z",
    ...overrides,
  });
}

function pr2927StaleReservationAuthorization(dispatch, overrides = {}) {
  return {
    operator_login: "allenchan",
    repository_permissions_push: true,
    permission_source: "gh-api-repository",
    target_repository: "devpro-tw/devpro-agent-rules",
    pr_number: "2927",
    pr_state: "OPEN",
    pr_merged: false,
    base_repository: "devpro-tw/devpro-agent-rules",
    base_ref: "main",
    head_repository: "devpro-tw/devpro-agent-rules",
    head_ref: "bugfix/fix-post-pr-marker-non-ff-rebind",
    reserved_head_ref_oid: dispatch.head_ref_oid,
    observed_head_ref_oid: "c".repeat(40),
    confirmation_source: "interactive-tty",
    authorization_checked_at: "2026-10-01T03:00:00.000Z",
    ...overrides,
  };
}

function pr2927StaleReservationChallenge(dispatch, observedHead) {
  return `CLOSE stale second-review reservation ${dispatch.repository_slug}#${dispatch.pr_number} ${dispatch.dispatch_id} reserved=${dispatch.head_ref_oid} current=${observedHead} action=stale_reservation_closed`;
}

function plantDispatchRecord(rootDir, record) {
  const directory = path.join(rootDir, record.dispatch_id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "dispatch.json"), `${JSON.stringify(record)}\n`);
}

function auditCompletionInput(record, overrides = {}) {
  return {
    ...dispatchLifecycleIdentity(record),
    schema: "devpro-second-review-completion/v2",
    outcome: "reviewer_process_closed_audit_only",
    classification: "audit_only_verified",
    process_close_observed: true,
    ...overrides,
  };
}

function dispatchLifecycleIdentity(record) {
  return Object.fromEntries([
    "repository_slug",
    "pr_number",
    "head_ref_oid",
    "attempt_id",
    "dispatch_id",
    "previous_dispatch_id",
  ].map((field) => [field, record[field]]));
}

// strengthen-reviewer-model-selection T13 (D12): a valid reviewer-model-record
// writer input. Defaults describe the claude built-in-default/alias-expansion
// shape (design.md D13's own worked example), overridable per test.
function reviewerModelRecordInput(record, overrides = {}) {
  return {
    ...dispatchLifecycleIdentity(record),
    reviewer_cli_family: "claude",
    requested_model: "opus",
    requested_source: "built-in-default",
    requested_source_env_var: "none",
    requested_kind: "alias",
    observed_model: "claude-opus-5",
    observed_source: "execution-stream",
    observed_unavailable_reason: "none",
    agreement: "alias-expansion-expected",
    ...overrides,
  };
}

async function completeDispatch(helper, rootDir, record, stickyVerdict = "PASS") {
  await helper.claimDispatchInvocation({ rootDir, record });
  return helper.writeCompletionReceipt({
    rootDir,
    record: {
      ...record,
      schema: helper.COMPLETION_SCHEMA,
      outcome: "reviewer_process_closed_and_sticky_verified",
      classification: "sticky_verified",
      sticky_verdict: stickyVerdict,
      sticky_last_reviewed_sha: record.head_ref_oid,
      sticky_dispatch_id: record.dispatch_id,
      sticky_comment_id: 4242,
      sticky_comment_url: `https://github.com/${record.repository_slug}/pull/${record.pr_number}#issuecomment-4242`,
      process_close_observed: true,
    },
  });
}

// T2 (R4, R5, R13): external-evaluator dispatch/closure fixtures and a
// real-OS-process race helper (child_process, not same-process Promise.all —
// synchronous fs calls inside one process never actually interleave).
function externalDispatchRecord(overrides = {}) {
  return dispatchRecord({
    dispatch_id: "dispatch-external-1658",
    executor_kind: "external-evaluator",
    reviewer_family: "gemini",
    primary_family: "claude",
    reviewer_tool: "Gemini CLI",
    sticky_write_action: "create",
    sticky_target_comment_id: null,
    sticky_snapshot_digest: "d".repeat(64),
    issued_at: "2026-08-20T00:00:00.000Z",
    ...overrides,
  });
}

function externalReceiptPayload(dispatch, overrides = {}) {
  return {
    schema: "devpro-second-review-completion/v2",
    repository_slug: dispatch.repository_slug,
    pr_number: dispatch.pr_number,
    head_ref_oid: dispatch.head_ref_oid,
    attempt_id: dispatch.attempt_id,
    dispatch_id: dispatch.dispatch_id,
    previous_dispatch_id: dispatch.previous_dispatch_id,
    sticky_verdict: "PASS",
    sticky_last_reviewed_sha: dispatch.head_ref_oid,
    sticky_dispatch_id: dispatch.dispatch_id,
    sticky_comment_id: 5150,
    sticky_comment_url: `https://github.com/${dispatch.repository_slug}/pull/${dispatch.pr_number}#issuecomment-5150`,
    sticky_body_sha256: "e".repeat(64),
    ...overrides,
  };
}

function runInChildProcess(rootDir, code) {
  return new Promise((resolve, reject) => {
    const wrapped = `
      import { pathToFileURL } from "node:url";
      import { existsSync, writeFileSync as childWriteFileSync } from "node:fs";
      import path from "node:path";
      const helper = await import(${JSON.stringify(pathToFileURL(helperPath).href)});
      const rootDir = ${JSON.stringify(rootDir)};
      try {
        ${code}
      } catch (error) {
        process.stdout.write(JSON.stringify({
          ok: false,
          classification: error?.classification ?? null,
          message: String(error?.message ?? error),
        }));
      }
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", wrapped]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", () => {
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`child process produced non-JSON stdout: ${stdout}\nstderr: ${stderr}`));
      }
    });
  });
}

async function waitForFiles(paths) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (paths.every((filePath) => existsSync(filePath))) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`child processes did not reach the race barrier: ${paths.filter((filePath) => !existsSync(filePath)).join(", ")}`);
}

function withIntegrity(record) {
  return {
    ...record,
    integrity_id: createHash("sha256")
      .update(Buffer.from(JSON.stringify(record), "utf8"))
      .digest("hex"),
  };
}

function writeCanonicalEvidence(rootDir, dispatchId, fileName, record) {
  const evidencePath = path.join(rootDir, dispatchId, fileName);
  writeFileSync(evidencePath, `${JSON.stringify(withIntegrity(record))}\n`, "utf8");
  return evidencePath;
}

async function closeDispatchWithTerminal(helper, rootDir, record, {
  classification = "reviewer_completion_critical",
  lifecyclePhase = "post_close_transport_cleaned",
  claim = lifecyclePhase === "post_close_transport_cleaned",
} = {}) {
  let invocationClaimSha256 = null;
  if (claim) {
    const claimed = await helper.claimDispatchInvocation({ rootDir, record });
    if (lifecyclePhase === "post_close_transport_cleaned") {
      invocationClaimSha256 = createHash("sha256")
        .update(readFileSync(claimed.path))
        .digest("hex");
    }
  }
  const postSpawn = lifecyclePhase === "post_close_transport_cleaned";
  return helper.writeTerminalReceipt({
    rootDir,
    record: {
      ...record,
      schema: "devpro-second-review-closed-terminal/v1",
      outcome_group: helper.terminalReceiptOutcomeGroup(classification),
      classification,
      responsibility: "reviewer_invocation_lifecycle",
      created_at: "2026-07-18T00:00:00.000Z",
      process_spawned: postSpawn,
      lifecycle_phase: lifecyclePhase,
      process_close_observed: postSpawn,
      transport_cleanup_confirmed: true,
      invocation_claim_sha256: invocationClaimSha256,
    },
  });
}

// File timestamps and Date.now() come from different clocks: on Windows a file written just now can
// carry a time a few milliseconds ahead of Date.now(), so "aged" needs more than one millisecond of margin.
const AGED_MARGIN_MS = 60_000;

test("control-evidence helper closes the capsule lifecycle to exactly two terminal classes", () => {
  const source = helperSource();
  const required = [
    "reviewer_orchestration_permission_denied",
    "reviewer_orchestration_unknown",
  ];

  for (const classification of required) {
    assert.match(source, new RegExp(`(?:^|[^A-Za-z0-9_])${classification}(?:[^A-Za-z0-9_]|$)`));
  }
  assert.match(source, /CAPSULE_REQUIRED_CLASSIFICATIONS|capsuleRequiredClassifications/);
  const capsuleStart = source.indexOf("export const CAPSULE_REQUIRED_CLASSIFICATIONS");
  const capsuleEnd = source.indexOf("export const TERMINAL_RECEIPT_OUTCOME_CLASSIFICATIONS", capsuleStart);
  assert.notEqual(capsuleStart, -1);
  assert.notEqual(capsuleEnd, -1);
  assert.doesNotMatch(
    source.slice(capsuleStart, capsuleEnd),
    /reviewer_completion_unavailable/,
    "reviewer_completion_unavailable must default out of the new capsule lifecycle"
  );
});

// Scenario: Completed Operator Abandonment Is Idempotent
test("T10 operator abandonment publishes an immutable slot and derives only its own terminal", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    assert.equal(typeof helper.writeOperatorAbandonmentClosure, "function");
    assert.equal(typeof helper.readDispatchEvidenceStrict, "function");

    const dispatch = pr2927UnstartedDispatchRecord();
    plantDispatchRecord(rootDir, dispatch);
    const input = {
      rootDir,
      dispatchId: dispatch.dispatch_id,
      authorization: pr2927OperatorAuthorization(),
      confirmation: PR2927_UNSTARTED_CONFIRMATION,
    };
    const first = await helper.writeOperatorAbandonmentClosure(input);
    assert.equal(first.status, "abandoned-before-invocation");
    assert.equal(first.resumed, false);

    const raw = helper.readDispatchEvidence({ rootDir, dispatchId: dispatch.dispatch_id });
    assert.equal(raw.operatorAbandonment.record.runner_not_started, true);
    assert.equal(raw.operatorAbandonment.record.typed_confirmation, PR2927_UNSTARTED_CONFIRMATION);
    assert.equal(raw.terminal.classification, "operator_abandoned_pre_spawn");
    assert.equal(raw.terminal.outcome_group, "operator_abandonment");
    assert.equal(raw.terminal.process_spawned, false);
    assert.equal(raw.terminal.lifecycle_phase, "pre_spawn_known_terminal");
    assert.equal(raw.terminal.invocation_claim_sha256, null);
    assert.deepEqual(helper.readDispatchEvidenceStrict({ rootDir, dispatchId: dispatch.dispatch_id }).terminal, raw.terminal);

    const slotBytes = readFileSync(raw.operatorAbandonment.path);
    const terminalBytes = readFileSync(raw.paths.terminal);
    const replay = await helper.writeOperatorAbandonmentClosure(input);
    assert.equal(replay.status, "already_abandoned");
    assert.deepEqual(readFileSync(raw.operatorAbandonment.path), slotBytes);
    assert.deepEqual(readFileSync(raw.paths.terminal), terminalBytes);
    assert.equal(replay.record.created_at, first.record.created_at);
  });
});

// Scenario: Operator Abandonment Resumes Only the Exact Slot
// Scenario: Strict Readers Reject Slot-Only Operator Abandonment
test("T10 slot-only operator abandonment is raw-readable, strict-incomplete, and resumes byte-identically", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const dispatch = pr2927UnstartedDispatchRecord();
    plantDispatchRecord(rootDir, dispatch);
    const directory = path.join(rootDir, dispatch.dispatch_id);
    const slotPath = path.join(directory, "operator-abandonment-slot.json");
    const originalSlot = pr2927OperatorSlotRecord(dispatch);
    writeFileSync(slotPath, `${JSON.stringify(originalSlot)}\n`, "utf8");

    assert.equal(
      helper.readDispatchEvidence({ rootDir, dispatchId: dispatch.dispatch_id }).operatorAbandonment.record.integrity_id,
      originalSlot.integrity_id,
    );
    assert.throws(
      () => helper.readDispatchEvidenceStrict({ rootDir, dispatchId: dispatch.dispatch_id }),
      /operator-abandonment.*terminal|terminal.*operator-abandonment/i,
    );

    const slotBytes = readFileSync(slotPath);
    const result = await helper.writeOperatorAbandonmentClosure({
      rootDir,
      dispatchId: dispatch.dispatch_id,
      authorization: pr2927OperatorAuthorization({
        authorization_checked_at: "2026-09-30T12:30:00.000Z",
      }),
      confirmation: PR2927_UNSTARTED_CONFIRMATION,
    });
    assert.equal(result.status, "abandoned-before-invocation");
    assert.equal(result.resumed, true);
    assert.deepEqual(readFileSync(slotPath), slotBytes, "resume must preserve original slot bytes and timestamp");
    assert.equal(result.record.created_at, originalSlot.created_at);
    assert.equal(
      helper.readDispatchEvidenceStrict({ rootDir, dispatchId: dispatch.dispatch_id }).terminal.classification,
      "operator_abandoned_pre_spawn",
    );
  });
});

// Scenario: Operator Abandonment Is Limited to the Exact Unstarted PR #2927 Dispatch
// Scenario: Operator Closure Uses Only Its Valid Evidence Set
test("T10 operator abandonment rejects mismatched authority, competing evidence, and unknown inventory without writes", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const dispatch = pr2927UnstartedDispatchRecord();
    plantDispatchRecord(rootDir, dispatch);
    const input = {
      rootDir,
      dispatchId: dispatch.dispatch_id,
      authorization: pr2927OperatorAuthorization(),
      confirmation: PR2927_UNSTARTED_CONFIRMATION,
    };
    const snapshot = () => readdirSync(path.join(rootDir, dispatch.dispatch_id))
      .sort()
      .map((name) => [name, readFileSync(path.join(rootDir, dispatch.dispatch_id, name)).toString("base64")]);

    for (const [label, attempted] of [
      ["wrong PR", { ...input, authorization: pr2927OperatorAuthorization({ pr_number: "2928" }) }],
      ["wrong repository permission", { ...input, authorization: pr2927OperatorAuthorization({ repository_permissions_push: false }) }],
      ["wrong source branch", { ...input, authorization: pr2927OperatorAuthorization({ local_branch: "feature/other" }) }],
      ["wrong local commit", { ...input, authorization: pr2927OperatorAuthorization({ local_implementation_commit: "not-a-sha" }) }],
      ["wrong confirmation", { ...input, confirmation: "runner_not_started" }],
      ["wrong dispatch", { ...input, dispatchId: "dispatch-other" }],
    ]) {
      const before = snapshot();
      await assert.rejects(
        () => helper.writeOperatorAbandonmentClosure(attempted),
        (error) => error?.classification === "reviewer_dispatch_identity_collision",
        label,
      );
      assert.deepEqual(snapshot(), before, `${label} rejection must not change evidence bytes`);
    }

    writeFileSync(path.join(rootDir, dispatch.dispatch_id, "unknown-evidence.json"), "{}\n", "utf8");
    const beforeUnknown = snapshot();
    await assert.rejects(
      () => helper.writeOperatorAbandonmentClosure(input),
      (error) => error?.classification === "reviewer_dispatch_identity_collision",
      "unknown lifecycle evidence must block operator closure",
    );
    assert.deepEqual(snapshot(), beforeUnknown);
  });
});

// Scenario: Operator Abandonment Requires a Truly Unclaimed Dispatch
test("T10 operator abandonment rejects an invocation-claimed dispatch without writes", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const dispatch = pr2927UnstartedDispatchRecord();
    plantDispatchRecord(rootDir, dispatch);
    await helper.claimDispatchInvocation({ rootDir, record: dispatch });
    const snapshot = () => readdirSync(path.join(rootDir, dispatch.dispatch_id))
      .sort()
      .map((name) => [name, readFileSync(path.join(rootDir, dispatch.dispatch_id, name)).toString("base64")]);
    const before = snapshot();

    await assert.rejects(
      () => helper.writeOperatorAbandonmentClosure({
        rootDir,
        dispatchId: dispatch.dispatch_id,
        authorization: pr2927OperatorAuthorization(),
        confirmation: PR2927_UNSTARTED_CONFIRMATION,
      }),
      (error) => error?.classification === "reviewer_dispatch_identity_collision",
    );
    assert.deepEqual(snapshot(), before, "a claimed dispatch cannot be reclassified as runner_not_started");
  });
});

// Scenario: External-Evaluator Dispatch Cannot Be Operator-Abandoned
test("T10 operator abandonment rejects an external-evaluator dispatch without writes", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const dispatch = externalDispatchRecord({
      repository_slug: "devpro-tw/devpro-agent-rules",
      pr_number: "2927",
      head_ref_oid: "1ca5d65c55dcb15f5395c201d413ce4a164ef327",
      attempt_id: "second-review-pr-2927-1ca5d65c55dc-initial-56293eef-eb39-4583-93bc-d20a75e8c846",
      dispatch_id: "dispatch-791fa840-4c9a-41f5-b376-93bfd20ad602",
      previous_dispatch_id: "dispatch-79f1b681-bca6-41c8-bd79-e129b1458be3",
    });
    plantDispatchRecord(rootDir, dispatch);
    const before = readdirSync(path.join(rootDir, dispatch.dispatch_id)).sort();

    await assert.rejects(
      () => helper.writeOperatorAbandonmentClosure({
        rootDir,
        dispatchId: dispatch.dispatch_id,
        authorization: pr2927OperatorAuthorization(),
        confirmation: PR2927_UNSTARTED_CONFIRMATION,
      }),
      (error) => error?.classification === "reviewer_dispatch_identity_collision",
    );
    assert.deepEqual(readdirSync(path.join(rootDir, dispatch.dispatch_id)).sort(), before);
  });
});

test("T10 generic terminal writing cannot forge the operator-abandoned classification", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const dispatch = pr2927UnstartedDispatchRecord();
    plantDispatchRecord(rootDir, dispatch);

    await assert.rejects(
      () => helper.writeTerminalReceipt({
        rootDir,
        record: {
          ...dispatch,
          schema: helper.TERMINAL_RECEIPT_SCHEMA,
          outcome_group: "operator_abandonment",
          classification: "operator_abandoned_pre_spawn",
          responsibility: "reviewer_invocation_lifecycle",
          created_at: "2026-09-30T12:01:00.000Z",
          process_spawned: false,
          lifecycle_phase: "pre_spawn_known_terminal",
          process_close_observed: false,
          transport_cleanup_confirmed: true,
          invocation_claim_sha256: null,
        },
      }),
      (error) => error?.classification === "reviewer_dispatch_identity_collision",
    );
    assert.deepEqual(
      readdirSync(path.join(rootDir, dispatch.dispatch_id)).sort(),
      ["dispatch.json"],
      "generic terminal writer must not create the operator slot or terminal",
    );
  });
});

test("T10 completed operator closure blocks every competing lifecycle writer without changing its bytes", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const dispatch = pr2927UnstartedDispatchRecord();
    plantDispatchRecord(rootDir, dispatch);
    await helper.writeOperatorAbandonmentClosure({
      rootDir,
      dispatchId: dispatch.dispatch_id,
      authorization: pr2927OperatorAuthorization(),
      confirmation: PR2927_UNSTARTED_CONFIRMATION,
    });
    const snapshot = () => readdirSync(path.join(rootDir, dispatch.dispatch_id))
      .sort()
      .map((name) => [name, readFileSync(path.join(rootDir, dispatch.dispatch_id, name)).toString("base64")]);
    const before = snapshot();
    const genericTerminal = {
      ...dispatch,
      schema: helper.TERMINAL_RECEIPT_SCHEMA,
      outcome_group: "spawn_or_probe_failure",
      classification: "reviewer_cli_spawn_failed",
      responsibility: "reviewer_invocation_lifecycle",
      created_at: "2026-09-30T12:02:00.000Z",
      process_spawned: false,
      lifecycle_phase: "pre_spawn_known_terminal",
      process_close_observed: false,
      transport_cleanup_confirmed: true,
      invocation_claim_sha256: null,
    };
    const capsule = {
      ...dispatch,
      schema: helper.FAULT_CAPSULE_SCHEMA,
      classification: "reviewer_orchestration_unknown",
      evidence_provenance: "provider_candidate_unmatched",
      evidence_confidence: "indeterminate",
      matcher_id: "none",
      denied_action_class: "unknown",
      redacted_excerpt: "blocked after operator closure",
    };
    const attempts = [
      ["claim", () => helper.claimDispatchInvocation({ rootDir, record: dispatch })],
      ["terminal", () => helper.writeTerminalReceipt({ rootDir, record: genericTerminal })],
      ["fault", () => helper.writeFaultCapsule({ rootDir, record: capsule })],
      ["completion", () => helper.writeCompletionReceipt({ rootDir, record: auditCompletionInput(dispatch) })],
      ["external slot", () => helper.writeExternalClosureSlot({ rootDir, dispatchId: dispatch.dispatch_id, kind: "voided" })],
      ["consumption", () => helper.writeConsumptionReceipt({ rootDir, record: { ...dispatch, schema: helper.FAULT_CONSUMPTION_SCHEMA, outcome: "blocked_orchestration_fault" } })],
      ["supersession", () => helper.writeSupersessionReceipt({ rootDir, faultDispatchId: dispatch.dispatch_id, record: { ...dispatch } })],
      ["reviewer-model", () => helper.writeReviewerModelRecord({ rootDir, record: reviewerModelRecordInput(dispatch) })],
    ];
    for (const [label, attempt] of attempts) {
      await assert.rejects(
        attempt,
        (error) => error?.classification === "reviewer_dispatch_identity_collision",
        label,
      );
      assert.deepEqual(snapshot(), before, `${label} must preserve the complete operator closure byte-for-byte`);
    }
  });
});

test("T10 operator-abandonment audit evidence is not removed by ordinary TTL cleanup", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const dispatch = pr2927UnstartedDispatchRecord();
    plantDispatchRecord(rootDir, dispatch);
    await helper.writeOperatorAbandonmentClosure({
      rootDir,
      dispatchId: dispatch.dispatch_id,
      authorization: pr2927OperatorAuthorization(),
      confirmation: PR2927_UNSTARTED_CONFIRMATION,
    });
    const result = await helper.cleanupDispatchEvidence({
      rootDir,
      dispatchId: dispatch.dispatch_id,
      markerPresent: false,
      now: Date.now() + 10 * 60 * 60_000,
    });
    assert.equal(result.reason, "operator-abandonment-audit-retained");
    assert.equal(existsSync(path.join(rootDir, dispatch.dispatch_id, "operator-abandonment-slot.json")), true);
    assert.equal(existsSync(path.join(rootDir, dispatch.dispatch_id, "terminal-receipt.json")), true);
  });
});

// Scenario: Operator Abandonment Serializes Against Lifecycle Writers
test("T10 operator abandonment serializes against claim, terminal, fault, and completion in separate processes", async () => {
  const helper = await loadHelper();
  for (const competingWriter of ["claim", "terminal", "fault", "completion"]) {
    await withTempDir(async (rootDir) => {
      const dispatch = pr2927UnstartedDispatchRecord();
      plantDispatchRecord(rootDir, dispatch);
      const operatorReady = path.join(rootDir, "ready-operator");
      const competitorReady = path.join(rootDir, "ready-competitor");
      const operatorInput = {
        rootDir,
        dispatchId: dispatch.dispatch_id,
        authorization: pr2927OperatorAuthorization(),
        confirmation: PR2927_UNSTARTED_CONFIRMATION,
      };
      const operatorCode = `
        childWriteFileSync(path.join(rootDir, "ready-operator"), "1");
        const result = await helper.writeOperatorAbandonmentClosure(${JSON.stringify(operatorInput)});
        process.stdout.write(JSON.stringify({ ok: true, winner: "operator", status: result.status }));
      `;
      let competitorAction;
      if (competingWriter === "claim") {
        competitorAction = `await helper.claimDispatchInvocation({ rootDir, record: ${JSON.stringify(dispatch)} });`;
      } else if (competingWriter === "terminal") {
        competitorAction = `await helper.writeTerminalReceipt({ rootDir, record: {
          ...${JSON.stringify(dispatch)}, schema: helper.TERMINAL_RECEIPT_SCHEMA,
          outcome_group: "spawn_or_probe_failure", classification: "reviewer_cli_spawn_failed",
          responsibility: "reviewer_invocation_lifecycle", created_at: "2026-09-30T12:01:00.000Z",
          process_spawned: false, lifecycle_phase: "pre_spawn_known_terminal",
          process_close_observed: false, transport_cleanup_confirmed: true, invocation_claim_sha256: null,
        } });`;
      } else if (competingWriter === "fault") {
        competitorAction = `await helper.writeFaultCapsule({ rootDir, record: {
          ...${JSON.stringify(dispatch)}, schema: helper.FAULT_CAPSULE_SCHEMA,
          classification: "reviewer_orchestration_unknown", evidence_provenance: "provider_candidate_unmatched",
          evidence_confidence: "indeterminate", matcher_id: "none", denied_action_class: "unknown",
          redacted_excerpt: "bounded race fixture",
        } });`;
      } else {
        competitorAction = `await helper.claimDispatchInvocation({ rootDir, record: ${JSON.stringify(dispatch)} });
          await helper.writeCompletionReceipt({ rootDir, record: {
            ...${JSON.stringify(dispatch)}, schema: helper.COMPLETION_SCHEMA,
            outcome: "reviewer_process_closed_and_sticky_verified", classification: "sticky_verified",
            sticky_verdict: "PASS", sticky_last_reviewed_sha: ${JSON.stringify(dispatch.head_ref_oid)},
            sticky_dispatch_id: ${JSON.stringify(dispatch.dispatch_id)}, sticky_comment_id: 5150,
            sticky_comment_url: "https://github.com/devpro-tw/devpro-agent-rules/pull/2927#issuecomment-5150",
            process_close_observed: true,
          } });`;
      }
      const competitorCode = `
        childWriteFileSync(path.join(rootDir, "ready-competitor"), "1");
        ${competitorAction}
        process.stdout.write(JSON.stringify({ ok: true, winner: ${JSON.stringify(competingWriter)} }));
      `;

      const release = helper.acquireCapacityLockForTest(rootDir, { waitMs: 1 });
      const operatorRun = runInChildProcess(rootDir, operatorCode);
      const competitorRun = runInChildProcess(rootDir, competitorCode);
      try {
        await waitForFiles([operatorReady, competitorReady]);
      } finally {
        release();
      }
      const results = await Promise.all([operatorRun, competitorRun]);
      const winners = results.filter((result) => result.ok);
      assert.equal(winners.length, 1, `${competingWriter} race must serialize to one winner: ${JSON.stringify(results)}`);

      const evidence = helper.readDispatchEvidence({ rootDir, dispatchId: dispatch.dispatch_id });
      if (winners[0].winner === "operator") {
        assert.equal(evidence.operatorAbandonment.record.runner_not_started, true);
        assert.equal(evidence.terminal.classification, "operator_abandoned_pre_spawn");
        assert.equal(evidence.invocationClaim, null);
        assert.equal(evidence.completion, null);
        assert.equal(evidence.capsule, null);
      } else {
        assert.equal(evidence.operatorAbandonment.present, false);
        if (competingWriter === "claim") assert.ok(evidence.invocationClaim);
        if (competingWriter === "terminal") assert.equal(evidence.terminal.classification, "reviewer_cli_spawn_failed");
        if (competingWriter === "fault") assert.ok(evidence.capsule);
        if (competingWriter === "completion") {
          assert.ok(evidence.invocationClaim);
          assert.equal(evidence.completion.classification, "sticky_verified");
        }
      }
    });
  }
});

// Scenario: Stale unstarted reservation closure is a distinct predecessor-only terminal.
test("Scenario: Slot-only stale closure resumes after another head movement — retry derives the terminal from the same immutable slot", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    assert.equal(typeof helper.writeStaleReservationClosure, "function");
    const dispatch = pr2927UnstartedDispatchRecord();
    plantDispatchRecord(rootDir, dispatch);
    const observedHead = "c".repeat(40);
    const input = {
      rootDir,
      dispatchId: dispatch.dispatch_id,
      authorization: pr2927StaleReservationAuthorization(dispatch, { observed_head_ref_oid: observedHead }),
      confirmation: pr2927StaleReservationChallenge(dispatch, observedHead),
    };
    const first = await helper.writeStaleReservationClosure(input);
    assert.equal(first.status, "closed-stale-reservation-before-invocation");
    assert.equal(first.resumed, false);
    const raw = helper.readDispatchEvidence({ rootDir, dispatchId: dispatch.dispatch_id });
    assert.equal(raw.lifecycleSlot.record.kind, "stale_reservation_closed");
    assert.equal(raw.lifecycleSlot.record.observed_head_ref_oid, observedHead);
    assert.equal(raw.terminal.outcome_group, "stale_reservation_closure");
    assert.equal(raw.terminal.classification, "stale_reservation_closed_pre_spawn");
    assert.equal(raw.invocationClaim, null);
    assert.equal(raw.completion, null);
    assert.deepEqual(helper.readDispatchEvidenceStrict({ rootDir, dispatchId: dispatch.dispatch_id }).terminal, raw.terminal);

    const slotBytes = readFileSync(raw.lifecycleSlot.path);
    const terminalBytes = readFileSync(raw.paths.terminal);
    const retry = await helper.writeStaleReservationClosure({
      ...input,
      authorization: pr2927StaleReservationAuthorization(dispatch, { observed_head_ref_oid: "d".repeat(40) }),
      confirmation: "head moved; retry derives from immutable slot",
    });
    assert.equal(retry.status, "already-closed-stale-reservation");
    assert.equal(retry.resumed, true);
    assert.deepEqual(readFileSync(raw.lifecycleSlot.path), slotBytes);
    assert.deepEqual(readFileSync(raw.paths.terminal), terminalBytes);
    assert.equal(retry.record.created_at, first.record.created_at);
  });
});

// Round-7 finding R7-1 of PR #2927: the stale-reservation slot is committed before its terminal, so an
// interruption between the two must leave the slot as the single winner. Every other lifecycle writer
// has to refuse, publish nothing, and a retry has to derive the one terminal from the same slot.
function staleSlotCompetingWriters(helper, rootDir, dispatch) {
  const claimedRecord = { ...dispatch };
  return {
    "invocation claim": () => helper.claimDispatchInvocation({ rootDir, record: claimedRecord }),
    "terminal receipt": () => helper.writeTerminalReceipt({ rootDir, record: {
      ...dispatch, schema: helper.TERMINAL_RECEIPT_SCHEMA,
      outcome_group: "spawn_or_probe_failure", classification: "reviewer_cli_spawn_failed",
      responsibility: "reviewer_invocation_lifecycle", created_at: "2026-09-30T12:01:00.000Z",
      process_spawned: false, lifecycle_phase: "pre_spawn_known_terminal",
      process_close_observed: false, transport_cleanup_confirmed: true, invocation_claim_sha256: null,
    } }),
    "fault capsule": () => helper.writeFaultCapsule({ rootDir, record: {
      ...dispatch, schema: helper.FAULT_CAPSULE_SCHEMA,
      classification: "reviewer_orchestration_unknown", evidence_provenance: "provider_candidate_unmatched",
      evidence_confidence: "indeterminate", matcher_id: "none", denied_action_class: "unknown",
      redacted_excerpt: "bounded stale-slot fixture",
    } }),
    "completion receipt": () => helper.writeCompletionReceipt({ rootDir, record: {
      ...dispatch, schema: helper.COMPLETION_SCHEMA,
      outcome: "reviewer_process_closed_and_sticky_verified", classification: "sticky_verified",
      sticky_verdict: "PASS", sticky_last_reviewed_sha: dispatch.head_ref_oid,
      sticky_dispatch_id: dispatch.dispatch_id, sticky_comment_id: 5150,
      sticky_comment_url: "https://github.com/devpro-tw/devpro-agent-rules/pull/2927#issuecomment-5150",
      process_close_observed: true,
    } }),
    "consumption receipt": () => helper.writeConsumptionReceipt({ rootDir, record: { ...dispatch } }),
    "reviewer model record": () => helper.writeReviewerModelRecord({ rootDir, record: { ...dispatch } }),
    "fault supersession receipt": () => helper.writeSupersessionReceipt({
      rootDir, faultDispatchId: dispatch.dispatch_id, record: { verified_dispatch_id: dispatch.dispatch_id },
    }),
    "external closure slot": () => helper.writeExternalClosureSlot({ rootDir, dispatchId: dispatch.dispatch_id }),
    "external completion receipt": () => helper.writeExternalCompletionReceipt({ rootDir, dispatchId: dispatch.dispatch_id }),
    "external terminal receipt": () => helper.writeExternalVoidTerminalReceipt({ rootDir, dispatchId: dispatch.dispatch_id }),
    "operator abandonment": () => helper.writeOperatorAbandonmentClosure({
      rootDir,
      dispatchId: dispatch.dispatch_id,
      authorization: pr2927OperatorAuthorization(),
      confirmation: PR2927_UNSTARTED_CONFIRMATION,
    }),
  };
}

test("Scenario: an interrupted stale-reservation closure leaves its slot as the single winner and retry recovers the one terminal", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const dispatch = pr2927UnstartedDispatchRecord();
    plantDispatchRecord(rootDir, dispatch);
    const observedHead = "c".repeat(40);
    const input = {
      rootDir,
      dispatchId: dispatch.dispatch_id,
      authorization: pr2927StaleReservationAuthorization(dispatch, { observed_head_ref_oid: observedHead }),
      confirmation: pr2927StaleReservationChallenge(dispatch, observedHead),
    };
    const first = await helper.writeStaleReservationClosure(input);
    const closed = helper.readDispatchEvidence({ rootDir, dispatchId: dispatch.dispatch_id });
    const directory = path.dirname(closed.paths.terminal);

    // Simulate the interruption after the slot commit and before the terminal publish.
    rmSync(closed.paths.terminal);
    const slotBytes = readFileSync(closed.lifecycleSlot.path);
    const inventory = () => readdirSync(directory).sort();
    const interrupted = inventory();
    assert.deepEqual(interrupted, ["dispatch-lifecycle-slot.json", "dispatch.json"], "the interrupted state is slot-only");
    assert.throws(
      () => helper.readDispatchEvidenceStrict({ rootDir, dispatchId: dispatch.dispatch_id }),
      /lifecycle slot is incomplete until its derived terminal exists/,
      "a slot-only closure is never read as a finished one"
    );

    for (const [name, attempt] of Object.entries(staleSlotCompetingWriters(helper, rootDir, dispatch))) {
      // Operator abandonment has no explicit slot check; the directory-inventory check refuses it
      // because the stale slot is an artifact it does not own.
      const refusal = name === "operator abandonment"
        ? /operator-abandonment dispatch inventory contains an incompatible or unknown artifact/
        : /cannot publish after a stale-reservation lifecycle slot exists/;
      await assert.rejects(attempt, refusal, `${name} must be refused by the committed slot`);
      assert.deepEqual(inventory(), interrupted, `${name} must publish nothing next to the slot`);
      assert.deepEqual(readFileSync(closed.lifecycleSlot.path), slotBytes, `${name} must not touch the slot`);
    }

    // TTL cleanup must not discard the only record of a closure that still needs its terminal.
    const agedNow = Date.now() + helper.COMPLETE_CHAIN_OWNER_TTL_MS + AGED_MARGIN_MS;
    const cleanup = await helper.cleanupDispatchEvidence({
      rootDir, dispatchId: dispatch.dispatch_id, markerPresent: false, now: agedNow,
    });
    assert.equal(cleanup.cleaned, false, JSON.stringify(cleanup));
    assert.equal(cleanup.reason, "stale-reservation-audit-retained");
    assert.deepEqual(inventory(), interrupted, "slot-only stale closure survives TTL cleanup");

    const retry = await helper.writeStaleReservationClosure(input);
    assert.equal(retry.status, "closed-stale-reservation-before-invocation");
    assert.equal(retry.resumed, true);
    const recovered = helper.readDispatchEvidenceStrict({ rootDir, dispatchId: dispatch.dispatch_id });
    assert.equal(recovered.terminal.classification, "stale_reservation_closed_pre_spawn");
    assert.equal(recovered.terminal.created_at, first.record.created_at, "the recovered terminal derives from the same immutable slot");
    assert.deepEqual(readFileSync(closed.lifecycleSlot.path), slotBytes);
    assert.deepEqual(inventory(), ["dispatch-lifecycle-slot.json", "dispatch.json", "terminal-receipt.json"]);
    assert.equal(recovered.invocationClaim, null);
    assert.equal(recovered.completion, null);
    assert.equal(recovered.capsule, null);
    const afterRecovery = await helper.cleanupDispatchEvidence({
      rootDir, dispatchId: dispatch.dispatch_id, markerPresent: false, now: agedNow,
    });
    assert.equal(afterRecovery.reason, "stale-reservation-audit-retained", "the recovered closure stays retained as audit proof");
    assert.deepEqual(inventory(), ["dispatch-lifecycle-slot.json", "dispatch.json", "terminal-receipt.json"]);
  });
});

test("stale reservation closure serializes against claim, terminal, fault, and completion in separate processes", async () => {
  const helper = await loadHelper();
  for (const competingWriter of ["claim", "terminal", "fault", "completion"]) {
    await withTempDir(async (rootDir) => {
      const dispatch = pr2927UnstartedDispatchRecord();
      plantDispatchRecord(rootDir, dispatch);
      const observedHead = "c".repeat(40);
      const closureReady = path.join(rootDir, "ready-closure");
      const competitorReady = path.join(rootDir, "ready-competitor");
      const closureInput = {
        rootDir,
        dispatchId: dispatch.dispatch_id,
        authorization: pr2927StaleReservationAuthorization(dispatch, { observed_head_ref_oid: observedHead }),
        confirmation: pr2927StaleReservationChallenge(dispatch, observedHead),
      };
      const closureCode = `
        childWriteFileSync(path.join(rootDir, "ready-closure"), "1");
        const result = await helper.writeStaleReservationClosure(${JSON.stringify(closureInput)});
        process.stdout.write(JSON.stringify({ ok: true, winner: "closure", status: result.status }));
      `;
      const competitorActions = {
        claim: `await helper.claimDispatchInvocation({ rootDir, record: ${JSON.stringify(dispatch)} });`,
        terminal: `await helper.writeTerminalReceipt({ rootDir, record: {
          ...${JSON.stringify(dispatch)}, schema: helper.TERMINAL_RECEIPT_SCHEMA,
          outcome_group: "spawn_or_probe_failure", classification: "reviewer_cli_spawn_failed",
          responsibility: "reviewer_invocation_lifecycle", created_at: "2026-09-30T12:01:00.000Z",
          process_spawned: false, lifecycle_phase: "pre_spawn_known_terminal",
          process_close_observed: false, transport_cleanup_confirmed: true, invocation_claim_sha256: null,
        } });`,
        fault: `await helper.writeFaultCapsule({ rootDir, record: {
          ...${JSON.stringify(dispatch)}, schema: helper.FAULT_CAPSULE_SCHEMA,
          classification: "reviewer_orchestration_unknown", evidence_provenance: "provider_candidate_unmatched",
          evidence_confidence: "indeterminate", matcher_id: "none", denied_action_class: "unknown",
          redacted_excerpt: "bounded race fixture",
        } });`,
        completion: `await helper.claimDispatchInvocation({ rootDir, record: ${JSON.stringify(dispatch)} });
          await helper.writeCompletionReceipt({ rootDir, record: {
            ...${JSON.stringify(dispatch)}, schema: helper.COMPLETION_SCHEMA,
            outcome: "reviewer_process_closed_and_sticky_verified", classification: "sticky_verified",
            sticky_verdict: "PASS", sticky_last_reviewed_sha: ${JSON.stringify(dispatch.head_ref_oid)},
            sticky_dispatch_id: ${JSON.stringify(dispatch.dispatch_id)}, sticky_comment_id: 5150,
            sticky_comment_url: "https://github.com/devpro-tw/devpro-agent-rules/pull/2927#issuecomment-5150",
            process_close_observed: true,
          } });`,
      };
      const competitorCode = `
        childWriteFileSync(path.join(rootDir, "ready-competitor"), "1");
        ${competitorActions[competingWriter]}
        process.stdout.write(JSON.stringify({ ok: true, winner: ${JSON.stringify(competingWriter)} }));
      `;

      const release = helper.acquireCapacityLockForTest(rootDir, { waitMs: 1 });
      const closureRun = runInChildProcess(rootDir, closureCode);
      const competitorRun = runInChildProcess(rootDir, competitorCode);
      try {
        await waitForFiles([closureReady, competitorReady]);
      } finally {
        release();
      }
      const results = await Promise.all([closureRun, competitorRun]);
      const winners = results.filter((result) => result.ok);
      assert.equal(winners.length, 1, `${competingWriter} race must serialize to one winner: ${JSON.stringify(results)}`);

      const evidence = helper.readDispatchEvidence({ rootDir, dispatchId: dispatch.dispatch_id });
      if (winners[0].winner === "closure") {
        assert.equal(evidence.lifecycleSlot.record.kind, "stale_reservation_closed");
        assert.equal(evidence.terminal.classification, "stale_reservation_closed_pre_spawn");
        assert.equal(evidence.invocationClaim, null);
        assert.equal(evidence.completion, null);
        assert.equal(evidence.capsule, null);
      } else {
        assert.notEqual(evidence.lifecycleSlot?.record?.kind, "stale_reservation_closed");
        if (competingWriter === "claim") assert.ok(evidence.invocationClaim);
        if (competingWriter === "terminal") assert.equal(evidence.terminal.classification, "reviewer_cli_spawn_failed");
        if (competingWriter === "fault") assert.ok(evidence.capsule);
        if (competingWriter === "completion") {
          assert.ok(evidence.invocationClaim);
          assert.equal(evidence.completion.classification, "sticky_verified");
        }
      }
    });
  }
});

test("stale reservation closure rejects same-head, mismatched, unauthorized, and incorrectly challenged attempts without writes", async () => {
  const helper = await loadHelper();
  for (const [label, authorizationPatch, confirmationPatch] of [
    ["same head", { observed_head_ref_oid: pr2927UnstartedDispatchRecord().head_ref_oid }, null],
    ["permission", { repository_permissions_push: false }, null],
    ["closed PR", { pr_state: "CLOSED" }, null],
    ["wrong source", { head_ref: "bugfix/other" }, null],
    ["challenge mismatch", {}, "CLOSE someone else's dispatch"],
  ]) {
    await withTempDir(async (rootDir) => {
      const dispatch = pr2927UnstartedDispatchRecord();
      plantDispatchRecord(rootDir, dispatch);
      const observedHead = authorizationPatch.observed_head_ref_oid ?? "c".repeat(40);
      const authorization = pr2927StaleReservationAuthorization(dispatch, {
        ...authorizationPatch,
        observed_head_ref_oid: observedHead,
      });
      await assert.rejects(
        helper.writeStaleReservationClosure({
          rootDir,
          dispatchId: dispatch.dispatch_id,
          authorization,
          confirmation: confirmationPatch ?? pr2927StaleReservationChallenge(dispatch, observedHead),
        }),
        (error) => error?.classification === "reviewer_dispatch_identity_collision",
        label,
      );
      assert.deepEqual(readdirSync(path.join(rootDir, dispatch.dispatch_id)).sort(), ["dispatch.json"]);
    });
  }
});

test("Scenario: Runner claim and stale close have one immutable winner — both orders serialize on one lifecycle slot", async () => {
  const helper = await loadHelper();
  for (const winner of ["runner", "stale-close"]) {
    await withTempDir(async (rootDir) => {
      const dispatch = pr2927UnstartedDispatchRecord();
      plantDispatchRecord(rootDir, dispatch);
      const observedHead = "c".repeat(40);
      const closeInput = {
        rootDir,
        dispatchId: dispatch.dispatch_id,
        authorization: pr2927StaleReservationAuthorization(dispatch, { observed_head_ref_oid: observedHead }),
        confirmation: pr2927StaleReservationChallenge(dispatch, observedHead),
      };
      if (winner === "runner") {
        await helper.claimDispatchInvocation({ rootDir, record: dispatch });
        assert.equal(helper.readDispatchEvidence({ rootDir, dispatchId: dispatch.dispatch_id }).lifecycleSlot.record.kind, "runner_claimed");
        const before = readdirSync(path.join(rootDir, dispatch.dispatch_id)).sort();
        await assert.rejects(helper.writeStaleReservationClosure(closeInput), /runner|claim|lifecycle/i);
        assert.deepEqual(readdirSync(path.join(rootDir, dispatch.dispatch_id)).sort(), before);
      } else {
        await helper.writeStaleReservationClosure(closeInput);
        const before = readdirSync(path.join(rootDir, dispatch.dispatch_id)).sort();
        await assert.rejects(helper.claimDispatchInvocation({ rootDir, record: dispatch }), /stale|lifecycle/i);
        assert.deepEqual(readdirSync(path.join(rootDir, dispatch.dispatch_id)).sort(), before);
      }
    });
  }
});

test("separate processes race for the exact lifecycle-slot path in both winner orders", async () => {
  const helper = await loadHelper();
  for (const expectedWinner of ["runner", "stale-close"]) {
    await withTempDir(async (rootDir) => {
      const dispatch = pr2927UnstartedDispatchRecord();
      plantDispatchRecord(rootDir, dispatch);
      const observedHead = "c".repeat(40);
      const closeInput = {
        rootDir,
        dispatchId: dispatch.dispatch_id,
        authorization: pr2927StaleReservationAuthorization(dispatch, { observed_head_ref_oid: observedHead }),
        confirmation: pr2927StaleReservationChallenge(dispatch, observedHead),
      };
      const runnerReady = path.join(rootDir, "runner-ready");
      const closeReady = path.join(rootDir, "close-ready");
      const start = path.join(rootDir, "race-start");
      const runnerCode = `
        childWriteFileSync(${JSON.stringify(runnerReady)}, "1");
        while (!existsSync(${JSON.stringify(start)})) await new Promise((resolve) => setTimeout(resolve, 1));
        await new Promise((resolve) => setTimeout(resolve, ${expectedWinner === "runner" ? 0 : 60}));
        await helper.claimDispatchInvocation({ rootDir, record: ${JSON.stringify(dispatch)} });
        process.stdout.write(JSON.stringify({ ok: true, winner: "runner" }));
      `;
      const closeCode = `
        childWriteFileSync(${JSON.stringify(closeReady)}, "1");
        while (!existsSync(${JSON.stringify(start)})) await new Promise((resolve) => setTimeout(resolve, 1));
        await new Promise((resolve) => setTimeout(resolve, ${expectedWinner === "stale-close" ? 0 : 60}));
        await helper.writeStaleReservationClosure(${JSON.stringify(closeInput)});
        process.stdout.write(JSON.stringify({ ok: true, winner: "stale-close" }));
      `;
      const runner = runInChildProcess(rootDir, runnerCode);
      const staleClose = runInChildProcess(rootDir, closeCode);
      await waitForFiles([runnerReady, closeReady]);
      writeFileSync(start, "1");
      const results = await Promise.all([runner, staleClose]);
      const winners = results.filter((result) => result.ok);
      assert.equal(winners.length, 1, `${expectedWinner} winner race must produce exactly one success: ${JSON.stringify(results)}`);
      assert.equal(winners[0].winner, expectedWinner);
      const evidence = helper.readDispatchEvidence({ rootDir, dispatchId: dispatch.dispatch_id });
      assert.ok(evidence.lifecycleSlot.record);
      assert.equal(evidence.lifecycleSlot.record.kind, expectedWinner === "runner" ? "runner_claimed" : "stale_reservation_closed");
      if (expectedWinner === "runner") {
        assert.ok(evidence.invocationClaim);
        assert.equal(evidence.terminal, null);
        assert.deepEqual(readdirSync(evidence.directory).sort(), ["dispatch-lifecycle-slot.json", "dispatch.json", "invocation-claim.json"]);
      } else {
        assert.equal(evidence.invocationClaim, null);
        assert.equal(evidence.terminal.classification, "stale_reservation_closed_pre_spawn");
        assert.deepEqual(readdirSync(evidence.directory).sort(), ["dispatch-lifecycle-slot.json", "dispatch.json", "terminal-receipt.json"]);
      }
    });
  }
});

test("legacy invocation claim without a lifecycle slot remains a hard block to stale closure", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const dispatch = pr2927UnstartedDispatchRecord();
    plantDispatchRecord(rootDir, dispatch);
    const directory = path.join(rootDir, dispatch.dispatch_id);
    const legacyClaim = withIntegrity({
      schema: "devpro-second-review-dispatch-invocation/v1",
      ...dispatchLifecycleIdentity(dispatch),
      outcome: "reviewer_invocation_claimed",
    });
    writeFileSync(path.join(directory, "invocation-claim.json"), `${JSON.stringify(legacyClaim)}\n`);
    const before = readdirSync(directory).sort();
    const observedHead = "c".repeat(40);
    await assert.rejects(helper.writeStaleReservationClosure({
      rootDir,
      dispatchId: dispatch.dispatch_id,
      authorization: pr2927StaleReservationAuthorization(dispatch, { observed_head_ref_oid: observedHead }),
      confirmation: pr2927StaleReservationChallenge(dispatch, observedHead),
    }));
    assert.deepEqual(readdirSync(directory).sort(), before);
  });
});

test("stale closure terminal cannot be forged by a generic terminal writer or satisfy review completion", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const dispatch = pr2927UnstartedDispatchRecord();
    plantDispatchRecord(rootDir, dispatch);
    const forged = {
      ...dispatchLifecycleIdentity(dispatch),
      schema: helper.TERMINAL_RECEIPT_SCHEMA,
      outcome_group: "stale_reservation_closure",
      classification: "stale_reservation_closed_pre_spawn",
      responsibility: "reviewer_invocation_lifecycle",
      created_at: "2026-10-01T03:00:00.000Z",
      process_spawned: false,
      lifecycle_phase: "pre_spawn_known_terminal",
      process_close_observed: false,
      transport_cleanup_confirmed: true,
      invocation_claim_sha256: null,
    };
    await assert.rejects(helper.writeTerminalReceipt({ rootDir, record: forged }));
    await assert.rejects(
      helper.writeCompletionReceipt({ rootDir, record: auditCompletionInput(dispatch) }),
    );
    assert.deepEqual(readdirSync(path.join(rootDir, dispatch.dispatch_id)).sort(), ["dispatch.json"]);
  });
});

// Scenario: Lifecycle Lock Failure Preserves Evidence
test("T12 lifecycle lock acquisition failure returns typed capacity refusal before any evidence write", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const dispatch = pr2927UnstartedDispatchRecord();
    plantDispatchRecord(rootDir, dispatch);
    const before = readdirSync(path.join(rootDir, dispatch.dispatch_id)).sort();
    const release = helper.acquireCapacityLockForTest(rootDir, { waitMs: 1 });
    try {
      await assert.rejects(
        () => helper.writeOperatorAbandonmentClosure({
          rootDir,
          dispatchId: dispatch.dispatch_id,
          authorization: pr2927OperatorAuthorization(),
          confirmation: PR2927_UNSTARTED_CONFIRMATION,
        }),
        (error) => error?.classification === "reviewer_dispatch_capacity_exceeded",
      );
    } finally {
      release();
    }
    assert.deepEqual(readdirSync(path.join(rootDir, dispatch.dispatch_id)).sort(), before);
  });
});

test("closed-terminal outcome groups expose the exact bounded classification allowlist", async () => {
  const helper = await loadHelper();
  const expected = {
    reviewer_blocking_verdict: [
      "reviewer_completion_critical",
      "reviewer_completion_unavailable",
    ],
    provider_blocked: [
      "claude_reviewer_provider_rate_limited",
      "claude_reviewer_authentication_failed",
    ],
    confirmed_timeout: ["reviewer_cli_timeout"],
    spawn_or_probe_failure: [
      "tool_discovery_blocked",
      "sticky_write_disposition_blocked",
      "reviewer_cli_spawn_failed",
      "review_material_scope_unresolvable",
      "probe_malformed",
      "probe_evidence_unavailable",
      "probe_capture_suspect",
      "recipe_parser_mismatch",
      "required_flag_absent_in_host_help",
      "reviewer_host_surface_unverified",
      "reviewer_write_surface_unverified",
    ],
    tool_surface_fault: [
      "reviewer_tool_surface_mismatch",
      "reviewer_tool_surface_evidence_missing",
    ],
    output_safety_overflow: ["reviewer_output_line_overflow"],
    terminal_contract_or_cli_failure: [
      "reviewer_cli_failed",
      "reviewer_cli_interrupted",
      "reviewer_model_provenance_unverified",
      "reviewer_cli_recipe_incompatible",
      "reviewer_completion_contract_missing",
      "reviewer_completion_stream_truncated",
      "reviewer_completion_reason_missing",
      "reviewer_completion_contract_invalid",
      "sticky_verification_input_missing",
      "sticky_verification_read_failed",
      "sticky_verification_parse_failed",
      "sticky_response_shape_invalid",
      "sticky_missing",
      "sticky_authority_ambiguous",
      "sticky_contract_invalid",
      "sticky_sha_mismatch",
      "sticky_dispatch_mismatch",
      "sticky_verdict_not_gate_satisfying",
      "sticky_verification_exception",
    ],
    // D5 (R5, T2): external evaluator void terminal group.
    external_evaluator_closed: ["external_evaluator_voided"],
    // D5/R2: the user-authorized pre-spawn operator closure is a distinct class.
    operator_abandonment: ["operator_abandoned_pre_spawn"],
    stale_reservation_closure: ["stale_reservation_closed_pre_spawn"],
    diagnostic_scan_closed: ["legacy_diagnostic_scan_closed"],
  };

  assert.deepEqual(helper.TERMINAL_RECEIPT_OUTCOME_CLASSIFICATIONS, expected);
  const flattened = Object.values(expected).flat();
  assert.deepEqual([...helper.TERMINAL_RECEIPT_CLASSIFICATIONS], flattened);
  for (const [group, classifications] of Object.entries(expected)) {
    for (const classification of classifications) {
      assert.equal(helper.terminalReceiptOutcomeGroup(classification), group);
    }
  }
  assert.equal(helper.terminalReceiptOutcomeGroup("unbounded_new_outcome"), null);
});

test("control-evidence helper pins immutable schemas, bounds, integrity, and collision semantics", () => {
  const source = helperSource();
  for (const anchor of [
    "devpro-second-review-dispatch/v1",
    "devpro-second-review-closed-terminal/v1",
    "devpro-second-review-operator-abandonment/v1",
    "devpro-second-review-dispatch-lifecycle-slot/v1",
    "devpro-second-review-fault-capsule/v1",
    "devpro-second-review-fault-consumption/v1",
    "devpro-second-review-fault-supersession/v1",
    "blocked_orchestration_fault",
    "superseded_by_verified_dispatch:",
    "reviewer_dispatch_identity_collision",
  ]) {
    assert.ok(source.includes(anchor), `missing control-evidence anchor: ${anchor}`);
  }

  for (const bound of [4096, 8192, 16384, 512, 32768, 16, 256, 524288, 16777216]) {
    assert.match(source, new RegExp(`(?:^|[^0-9])${bound}(?:[^0-9]|$)`), `missing bound ${bound}`);
  }
  assert.match(source, /MAX_BYTES_PER_PR_HEAD\s*=\s*524288/);
  assert.match(source, /MAX_BYTES_PER_REPOSITORY\s*=\s*16777216/);
  assert.doesNotMatch(
    source,
    /CLEANUP_AGE_MS\s*=\s*(?:524288|16777216)/,
    "byte-budget constants must not be reinterpreted as cleanup durations"
  );
  assert.match(source, /sha256|sha-256/i);
  assert.match(source, /wx|O_EXCL|exclusive/i);
  assert.match(source, /idempotent/i);
});

test("the rule's nominal worst-case evidence figure follows the code's per-file bounds", async () => {
  const helper = await loadHelper();
  const rule = readFileSync(repoPath(".devpro/agent-rules/second-review-control-evidence.md"), "utf8");
  const source = helperSource();
  const cap = Number(source.match(/const MAX_DISPATCH_EVIDENCE_BYTES = (\d+);/u)?.[1]);
  assert.ok(Number.isSafeInteger(cap) && cap > 0, "the aggregate cap constant must be readable");
  const nominalKib = helper.NOMINAL_FAULT_PATH_EVIDENCE_BYTES / 1024;
  assert.ok(Number.isInteger(nominalKib), "nominal worst case must be a whole number of KiB");
  assert.ok(rule.includes(`**${nominalKib} KiB`), `rule must quote the code's nominal worst case of ${nominalKib} KiB`);
  assert.equal(
    rule.includes(`**${nominalKib} KiB，已超出現行 cap**`),
    helper.NOMINAL_FAULT_PATH_EVIDENCE_BYTES > cap,
    "rule must disclose the nominal worst case exceeding the aggregate cap exactly when it does",
  );
  const obligation = rule.match(/任何增加互相可共存的 record 或放寬單筆上限前 MUST[^。]*。/u)?.[0] ?? "";
  for (const constant of ["MAX_DISPATCH_EVIDENCE_BYTES", "MAX_BYTES_PER_PR_HEAD", "MAX_BYTES_PER_REPOSITORY"]) {
    assert.ok(obligation.includes(constant), `the recompute obligation must name ${constant}`);
  }
});

test("bounded fault writers remain readable through consumption and supersession at serialized field limits", async () => {
  const helper = await loadHelper();
  const cap = Number(helperSource().match(/const MAX_DISPATCH_EVIDENCE_BYTES = (\d+);/u)?.[1]);
  const quote = '"'.repeat(256);
  const canonicalBytes = (record) => Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  const seal = (record) => {
    const { integrity_id: ignored, ...unsigned } = record;
    return withIntegrity(unsigned);
  };
  for (const identity of [
    { pr_number: "9".repeat(256), head_ref_oid: "a".repeat(40) },
    { pr_number: "none", head_ref_oid: quote },
  ]) {
    await withTempDir(async (rootDir) => {
      // Synthetic helper-accepted fields exercise JSON escaping, not GitHub metadata validity.
      const predecessor = dispatchRecord({ ...identity, repository_slug: quote,
        attempt_id: `${quote.slice(1)}p`, dispatch_id: "p".repeat(128) });
      const finish = async (record) => {
        if (record.pr_number !== "none") return completeDispatch(helper, rootDir, record);
        await helper.claimDispatchInvocation({ rootDir, record });
        return helper.writeCompletionReceipt({ rootDir, record: { ...record,
          schema: helper.COMPLETION_SCHEMA, outcome: "reviewer_process_closed_audit_only",
          classification: "audit_only_verified", process_close_observed: true } });
      };
      await helper.reserveDispatchRecord({ rootDir, record: predecessor });
      await finish(predecessor);
      const fault = { ...predecessor, attempt_id: `${quote.slice(1)}f`,
        dispatch_id: "f".repeat(128), previous_dispatch_id: predecessor.dispatch_id };
      await helper.reserveDispatchRecord({ rootDir, record: fault });
      await helper.claimDispatchInvocation({ rootDir, record: fault });
      const model = reviewerModelRecordInput(fault, { schema: helper.REVIEWER_MODEL_RECORD_SCHEMA, reviewer_cli_family: quote,
        requested_model: quote, requested_source: "env-override", requested_source_env_var: quote,
        requested_kind: "exact-id", observed_model: quote, agreement: "exact" });
      // Keep the model within its individual bound; serialization expands each quotation mark.
      while (canonicalBytes(withIntegrity(model)).length > 4096) {
        const field = ["reviewer_cli_family", "requested_model", "requested_source_env_var", "observed_model"]
          .find((key) => model[key].length > 1);
        assert.ok(field, "bounded model fixture must fit its individual record limit");
        model[field] = model[field].slice(0, -1);
      }
      await helper.writeReviewerModelRecord({ rootDir, record: model });
      const capsule = await helper.writeFaultCapsule({ rootDir, record: { ...fault,
        schema: helper.FAULT_CAPSULE_SCHEMA, classification: "reviewer_orchestration_unknown",
        evidence_provenance: quote, evidence_confidence: quote, matcher_id: quote,
        denied_action_class: quote, redacted_excerpt: "\u0001".repeat(512) } });
      const consumption = await helper.writeConsumptionReceipt({ rootDir, record: { ...fault,
        schema: helper.FAULT_CONSUMPTION_SCHEMA, outcome: "blocked_orchestration_fault",
        capsule_integrity_id: capsule.record.integrity_id } });
      const successor = { ...fault, attempt_id: `${quote.slice(1)}s`,
        dispatch_id: "s".repeat(128), previous_dispatch_id: fault.dispatch_id };
      await helper.reserveDispatchRecord({ rootDir, record: successor });
      await finish(successor);
      await helper.writeSupersessionReceipt({ rootDir, faultDispatchId: fault.dispatch_id, record: {
        ...successor, schema: helper.FAULT_SUPERSESSION_SCHEMA, fault_dispatch_id: fault.dispatch_id,
        verified_dispatch_id: successor.dispatch_id,
        outcome: `superseded_by_verified_dispatch:${successor.dispatch_id}`,
        consumption_integrity_id: consumption.record.integrity_id } });
      const evidence = helper.readDispatchEvidence({ rootDir, dispatchId: fault.dispatch_id });
      const files = ["dispatch.json", "dispatch-lifecycle-slot.json", "invocation-claim.json",
        "reviewer-model-record.json", "fault-capsule.json", "consumption-receipt.json", "supersession-receipt.json"];
      const total = files.reduce((sum, file) => sum + readFileSync(path.join(evidence.directory, file)).length, 0);
      assert.ok(total < cap, "the complete bounded writer path must fit the aggregate cap");
      assert.equal(evidence.capsule.redacted_excerpt.length, 512);
      assert.equal(evidence.supersession.consumption_integrity_id, evidence.consumption.integrity_id);
      assert.ok(helper.NOMINAL_FAULT_PATH_EVIDENCE_BYTES > cap,
        "nominal per-file allowances are not a reachable producer byte count");

      if (fault.pr_number !== "none") return;
      // Deliberately synthesize individually valid canonical reader input with extra fields.
      // This is a read-budget fixture, not output reachable through the public writers.
      const padded = (record, target) => {
        const base = seal({ ...record, padding: "" });
        const paddingBytes = target - canonicalBytes(base).length;
        assert.ok(paddingBytes >= 0);
        return seal({ ...record, padding: "x".repeat(paddingBytes) });
      };
      const claimBytes = canonicalBytes(padded(evidence.invocationClaim, 4096));
      const oldClaimBytes = readFileSync(evidence.paths.invocationClaim).length;
      const oldCapsuleBytes = readFileSync(evidence.paths.capsule).length;
      const atCapCapsule = padded(evidence.capsule, cap - total - claimBytes.length + oldClaimBytes + oldCapsuleBytes);
      assert.ok(canonicalBytes(atCapCapsule).length <= 16384);
      const publishReaderFixture = (record) => {
        const consumed = seal({ ...evidence.consumption, capsule_integrity_id: record.integrity_id });
        const superseded = seal({ ...evidence.supersession, consumption_integrity_id: consumed.integrity_id });
        for (const [file, value] of [[evidence.paths.capsule, record],
          [evidence.paths.consumption, consumed], [evidence.paths.supersession, superseded]]) {
          writeFileSync(file, canonicalBytes(value));
        }
      };
      writeFileSync(evidence.paths.invocationClaim, claimBytes);
      publishReaderFixture(atCapCapsule);
      assert.ok(helper.readDispatchEvidence({ rootDir, dispatchId: fault.dispatch_id }).supersession,
        "exactly the aggregate cap must remain readable");
      publishReaderFixture(seal({ ...atCapCapsule, padding: `${atCapCapsule.padding}x` }));
      const before = files.map((file) => readFileSync(path.join(evidence.directory, file)));
      assert.equal(before.reduce((sum, value) => sum + value.length, 0), cap + 1);
      assert.throws(() => helper.readDispatchEvidence({ rootDir, dispatchId: fault.dispatch_id }),
        (error) => error.classification === "reviewer_dispatch_identity_collision"
          && error.message === "dispatch evidence exceeds its aggregate byte budget");
      assert.deepEqual(files.map((file) => readFileSync(path.join(evidence.directory, file))), before,
        "aggregate rejection must preserve all evidence bytes");
    });
  }
});

test("the rule states the lineage approval age limit the code enforces", async () => {
  const helper = await loadHelper();
  const rule = readFileSync(repoPath(".devpro/agent-rules/second-review-control-evidence.md"), "utf8");
  const days = helper.LINEAGE_APPROVAL_MAX_AGE_MS / (24 * 60 * 60 * 1000);
  assert.ok(Number.isInteger(days), "the approval age limit must be a whole number of days");
  assert.ok(
    rule.includes(`\`LINEAGE_APPROVAL_MAX_AGE_MS\`（${days} 天）`),
    `rule must quote the code's ${days}-day approval age limit`,
  );
  for (const spec of [
    "openspec/specs/openspec-flow/spec.md",
    "openspec/changes/archive/2026-10-01-fix-post-pr-marker-non-ff-rebind/specs/openspec-flow/spec.md",
  ]) {
    assert.ok(
      readFileSync(repoPath(spec), "utf8").includes(`no older than ${days} days`),
      `${spec} must state the ${days}-day approval age limit`,
    );
  }
});

test("dispatch reservation verifies a retry's direct predecessor identity", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const first = dispatchRecord({ dispatch_id: "dispatch-lineage-first" });
    await helper.reserveDispatchRecord({ rootDir, record: first });

    await assert.rejects(
      () => helper.reserveDispatchRecord({
        rootDir,
        record: dispatchRecord({
          dispatch_id: "dispatch-lineage-missing",
          previous_dispatch_id: "dispatch-does-not-exist",
        }),
      }),
      /collision|predecessor|lineage/i
    );

    const foreign = dispatchRecord({
      repository_slug: "devpro/foreign",
      dispatch_id: "dispatch-lineage-foreign",
    });
    await helper.reserveDispatchRecord({ rootDir, record: foreign });
    await assert.rejects(
      () => helper.reserveDispatchRecord({
        rootDir,
        record: dispatchRecord({
          dispatch_id: "dispatch-lineage-mismatch",
          previous_dispatch_id: foreign.dispatch_id,
        }),
      }),
      /collision|predecessor|lineage|repository/i
    );

    const successor = dispatchRecord({
      dispatch_id: "dispatch-lineage-successor",
      previous_dispatch_id: first.dispatch_id,
      attempt_id: "second-review-pr-1658-abc123-rerender",
    });
    const reserved = await reserveWithMarkerWitness(helper, rootDir, successor);
    assert.equal(reserved.record.previous_dispatch_id, first.dispatch_id);
    assert.notEqual(
      reserved.record.attempt_id,
      first.attempt_id,
      "same-head retry lineage must allocate a fresh attempt directory identity"
    );

    await assert.rejects(
      () => helper.reserveDispatchRecord({
        rootDir,
        record: dispatchRecord({
          dispatch_id: "dispatch-lineage-reused-attempt",
          previous_dispatch_id: first.dispatch_id,
        }),
      }),
      /attempt_id must be fresh/
    );
  });
});

test("read-only dispatch verification proves the exact reservation without consuming a claim", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const record = {
      ...dispatchRecord({ dispatch_id: "dispatch-read-only-verification" }),
      packet_sha256: "1".repeat(64),
      carrier_root_id: "2".repeat(64),
      paged_full_material_sha256: "3".repeat(64),
      paged_full_material_created_at: "2026-08-13T00:00:00.000Z",
      paged_full_material_expires_at: "2026-08-13T02:00:00.000Z",
    };
    await helper.reserveDispatchRecord({ rootDir, record });
    assert.deepEqual(helper.verifyDispatchReservation({ rootDir, record }), {
      status: "verified",
      record,
    });
    const evidence = helper.readDispatchEvidence({ rootDir, dispatchId: record.dispatch_id });
    assert.equal(evidence.invocationClaim, null);

    assert.throws(
      () => helper.verifyDispatchReservation({
        rootDir,
        record: { ...record, packet_sha256: "4".repeat(64) },
      }),
      (error) => error?.classification === "reviewer_dispatch_identity_collision",
    );
  });
});

test("control-evidence helper keeps blocked consumption and supersession append-only", () => {
  const source = helperSource();

  assert.match(source, /consumption-receipt\.json/);
  assert.match(source, /supersession-receipt\.json/);
  assert.match(source, /invocation-claim\.json/);
  assert.match(source, /unconsumed|cleanup eligible|cleanup_eligible/i);
  assert.match(source, /atomic|rename|link/i);
  assert.doesNotMatch(
    source,
    /writeFileSync\([^\n]*consumption-receipt\.json[^\n]*\{[^\n]*flag:\s*["']w["']/,
    "final consumption evidence must never use an overwrite-capable write"
  );
});

test("control-evidence helper exclusively creates dispatch records and only permits exact idempotent reread", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    assert.equal(typeof helper.reserveDispatchRecord, "function");
    assert.equal(typeof helper.readDispatchEvidence, "function");

    const first = await helper.reserveDispatchRecord({ rootDir, record: dispatchRecord() });
    assert.equal(first.status, "created");
    const originalBytes = readFileSync(first.path);

    const repeated = await helper.reserveDispatchRecord({ rootDir, record: dispatchRecord() });
    assert.equal(repeated.status, "idempotent");
    assert.deepEqual(readFileSync(first.path), originalBytes);

    await assert.rejects(
      () => helper.reserveDispatchRecord({
        rootDir,
        record: dispatchRecord({ previous_dispatch_id: "different-predecessor" }),
      }),
      (error) => error?.classification === "reviewer_dispatch_identity_collision"
    );
    assert.deepEqual(readFileSync(first.path), originalBytes, "collision must never overwrite final evidence");
  });
});

test("control-evidence helper rolls back only an exact unclaimed renderer reservation", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const record = dispatchRecord({ dispatch_id: "dispatch-render-cas-loser" });
    const reserved = await helper.reserveDispatchRecord({ rootDir, record });
    assert.equal(existsSync(path.dirname(reserved.path)), true);

    const rolledBack = await helper.rollbackUnclaimedDispatchReservation({ rootDir, record });
    assert.deepEqual(rolledBack, {
      status: "rolled-back",
      dispatch_id: record.dispatch_id,
    });
    assert.equal(
      existsSync(path.dirname(reserved.path)),
      false,
      "a losing renderer must release the capacity reserved only for its unpublished dispatch"
    );

    await helper.reserveDispatchRecord({ rootDir, record });
    await helper.claimDispatchInvocation({ rootDir, record });
    assert.throws(
      () => helper.rollbackUnclaimedDispatchReservation({ rootDir, record }),
      (error) => error?.classification === "reviewer_dispatch_identity_collision"
    );
    assert.equal(
      existsSync(path.join(rootDir, record.dispatch_id, "invocation-claim.json")),
      true,
      "rollback must never remove a dispatch after invocation ownership was claimed"
    );
  });
});

test("control-evidence helper enforces the per-PR/head directory cap under concurrent reservations", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const records = Array.from({ length: 17 }, (_, index) => dispatchRecord({
      head_ref_oid: CANONICAL_HEAD_SHA,
      attempt_id: `second-review-pr-1658-canonical-${index}`,
      dispatch_id: `dispatch-1658-${index}`,
    }));

    const outcomes = await Promise.allSettled(
      records.map((record) => helper.reserveDispatchRecord({ rootDir, record }))
    );
    assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 16);
    assert.equal(outcomes.filter(({ status }) => status === "rejected").length, 1);
    assert.match(
      String(outcomes.find(({ status }) => status === "rejected")?.reason?.classification ?? ""),
      /capacity/i
    );

    const repeated = await helper.reserveDispatchRecord({ rootDir, record: records[0] });
    assert.equal(repeated.status, "idempotent", "an exact reread must remain valid at capacity");
  });
});

test("control-evidence helper fail-closes at the repo directory cap without deleting evidence", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const records = Array.from({ length: 512 }, (_, index) => dispatchRecord({
      pr_number: String(2000 + index),
      head_ref_oid: `head-${index}`,
      attempt_id: `second-review-repo-cap-${index}`,
      dispatch_id: `dispatch-repo-cap-${index}`,
    }));
    for (const record of records) {
      const directory = path.join(rootDir, record.dispatch_id);
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, "dispatch.json"), `${JSON.stringify(record)}\n`);
    }

    await assert.rejects(
      () => helper.reserveDispatchRecord({
        rootDir,
        record: dispatchRecord({
          pr_number: "9999",
          head_ref_oid: "head-over-cap",
          attempt_id: "second-review-repo-cap-overflow",
          dispatch_id: "dispatch-repo-cap-overflow",
        }),
      }),
      (error) => /capacity/i.test(String(error?.classification ?? ""))
    );

    const repeated = await helper.reserveDispatchRecord({ rootDir, record: records[511] });
    assert.equal(repeated.status, "idempotent", "an exact reread must not consume new capacity");
    assert.equal(
      records.every(({ dispatch_id: dispatchId }) =>
        existsSync(path.join(rootDir, dispatchId, "dispatch.json"))
      ),
      true,
      "capacity rejection must not delete existing evidence"
    );
  });
});

// A terminal receipt written by a newer tool than this reader: the classification and
// outcome group are well-formed but unknown here, so the strict per-dispatch read rejects it.
// Use a name no reader knows; a real classification (e.g. the stale-reservation closure this
// reader now recognizes) would stop being unknown once it is supported.
function writeUnknownTerminalReceipt(rootDir, record) {
  writeCanonicalEvidence(rootDir, record.dispatch_id, "terminal-receipt.json", {
    schema: "devpro-second-review-closed-terminal/v1",
    repository_slug: record.repository_slug,
    pr_number: record.pr_number,
    head_ref_oid: record.head_ref_oid,
    attempt_id: record.attempt_id,
    dispatch_id: record.dispatch_id,
    previous_dispatch_id: record.previous_dispatch_id,
    outcome_group: "future_tool_closure",
    classification: "future_tool_closed_pre_spawn",
    responsibility: "reviewer_invocation_lifecycle",
    created_at: "2026-10-01T04:51:29.554Z",
    process_spawned: false,
    lifecycle_phase: "pre_spawn_known_terminal",
    process_close_observed: false,
    transport_cleanup_confirmed: true,
    invocation_claim_sha256: null,
  });
}

test("capacity scan does not let one unreadable lifecycle receipt block reservations for other repositories or PRs", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const unreadable = dispatchRecord({
      pr_number: "2927",
      head_ref_oid: CANONICAL_HEAD_SHA,
      attempt_id: "second-review-pr-2927-canonical-unreadable",
      dispatch_id: "dispatch-2927-unreadable-lifecycle",
    });
    await helper.reserveDispatchRecord({ rootDir, record: unreadable });
    writeUnknownTerminalReceipt(rootDir, unreadable);

    assert.throws(
      () => helper.readDispatchEvidence({ rootDir, dispatchId: unreadable.dispatch_id }),
      /outcome group/i,
      "a strict per-dispatch read of the unreadable receipt must stay fail-closed"
    );

    const otherRepository = await helper.reserveDispatchRecord({
      rootDir,
      record: dispatchRecord({
        repository_slug: "devpro/runner-relay",
        pr_number: "7",
        head_ref_oid: "b".repeat(40),
        attempt_id: "second-review-pr-7-bbbbbbbbbbbb-initial",
        dispatch_id: "dispatch-runner-relay-7",
      }),
    });
    assert.equal(otherRepository.status, "created");

    const samePrOtherHead = await helper.reserveDispatchRecord({
      rootDir,
      record: dispatchRecord({
        pr_number: "2927",
        head_ref_oid: "c".repeat(40),
        attempt_id: "second-review-pr-2927-cccccccccccc-initial",
        dispatch_id: "dispatch-2927-other-head",
      }),
    });
    assert.equal(samePrOtherHead.status, "created");
  });
});

test("capacity scan still counts a dispatch whose lifecycle receipt is unreadable toward its PR/head cap", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const records = Array.from({ length: 16 }, (_, index) => dispatchRecord({
      head_ref_oid: CANONICAL_HEAD_SHA,
      attempt_id: `second-review-pr-1658-canonical-count-${index}`,
      dispatch_id: `dispatch-1658-count-${index}`,
    }));
    for (const record of records) {
      await helper.reserveDispatchRecord({ rootDir, record });
    }
    writeUnknownTerminalReceipt(rootDir, records[3]);

    await assert.rejects(
      () => helper.reserveDispatchRecord({
        rootDir,
        record: dispatchRecord({
          head_ref_oid: CANONICAL_HEAD_SHA,
          attempt_id: "second-review-pr-1658-canonical-count-overflow",
          dispatch_id: "dispatch-1658-count-overflow",
        }),
      }),
      (error) => /capacity/i.test(String(error?.classification ?? "")),
      "an unreadable lifecycle receipt must still occupy its PR/head slot, not silently free it"
    );

    const otherPr = await helper.reserveDispatchRecord({
      rootDir,
      record: dispatchRecord({
        pr_number: "9999",
        head_ref_oid: "e".repeat(40),
        attempt_id: "second-review-pr-9999-eeeeeeeeeeee-initial",
        dispatch_id: "dispatch-9999-other-pr",
      }),
    });
    assert.equal(
      otherPr.status,
      "created",
      "the rejection above must come from the PR/head count, not from the unreadable receipt"
    );
  });
});

test("capacity scan stays fail-closed when a dispatch identity file itself is unreadable or missing", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const broken = dispatchRecord({ dispatch_id: "dispatch-identity-broken" });
    await helper.reserveDispatchRecord({ rootDir, record: broken });
    writeFileSync(path.join(rootDir, broken.dispatch_id, "dispatch.json"), "{not json");

    const next = dispatchRecord({
      pr_number: "9001",
      head_ref_oid: "d".repeat(40),
      attempt_id: "second-review-pr-9001-dddddddddddd-initial",
      dispatch_id: "dispatch-identity-next",
    });
    await assert.rejects(
      () => helper.reserveDispatchRecord({ rootDir, record: next }),
      (error) => /capacity/i.test(String(error?.classification ?? ""))
    );

    rmSync(path.join(rootDir, broken.dispatch_id, "dispatch.json"));
    await assert.rejects(
      () => helper.reserveDispatchRecord({ rootDir, record: next }),
      (error) => /capacity/i.test(String(error?.classification ?? ""))
    );
  });
});

test("unrelated residue permits lifecycle writers but prevents uncertain component retirement", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const unrelatedDispatch = (pr) => dispatchRecord({
      pr_number: String(pr),
      head_ref_oid: "d".repeat(40),
      attempt_id: `second-review-pr-${pr}-dddddddddddd-initial`,
      dispatch_id: `dispatch-residue-${pr}`,
    });
    const completing = unrelatedDispatch(9101);
    const closing = unrelatedDispatch(9102);
    const rollingBack = unrelatedDispatch(9103);
    const cleanedBeforeResidue = unrelatedDispatch(9104);
    const cleanedAfterResidue = unrelatedDispatch(9106);
    const behindCorruptNeighbor = unrelatedDispatch(9107);
    for (const record of [completing, closing, rollingBack, cleanedBeforeResidue, cleanedAfterResidue, behindCorruptNeighbor]) {
      await helper.reserveDispatchRecord({ rootDir, record });
    }
    await completeDispatch(helper, rootDir, cleanedBeforeResidue);
    await completeDispatch(helper, rootDir, cleanedAfterResidue);
    const longAfter = () => Date.now() + 365 * 24 * 60 * 60 * 1000;
    const cleanBaseline = await helper.cleanupDispatchEvidence({
      rootDir,
      dispatchId: cleanedBeforeResidue.dispatch_id,
      markerPresent: false,
      now: longAfter(),
    });
    assert.equal(cleanBaseline.cleaned, true, "the baseline dispatch must be reclaimable on a clean root");

    // Residue an interrupted reservation or another tool can leave behind: a directory with no
    // dispatch identity file and a directory holding only a file this module does not recognize.
    mkdirSync(path.join(rootDir, "dispatch-residue-empty"));
    mkdirSync(path.join(rootDir, "dispatch-residue-unknown"));
    writeFileSync(path.join(rootDir, "dispatch-residue-unknown", "unknown-evidence.json"), "{}\n");

    await completeDispatch(helper, rootDir, completing);
    assert.equal(existsSync(path.join(rootDir, completing.dispatch_id, "completion-receipt.json")), true);
    await closeDispatchWithTerminal(helper, rootDir, closing);
    assert.equal(existsSync(path.join(rootDir, closing.dispatch_id, "terminal-receipt.json")), true);
    helper.rollbackUnclaimedDispatchReservation({ rootDir, record: rollingBack });
    assert.equal(existsSync(path.join(rootDir, rollingBack.dispatch_id)), false);
    const cleanup = await helper.cleanupDispatchEvidence({
      rootDir,
      dispatchId: cleanedAfterResidue.dispatch_id,
      markerPresent: false,
      now: longAfter(),
    });
    assert.equal(cleanup.reason, "incomplete-evidence", "unknown neighbor inventory cannot prove absence of incoming dependencies");
    assert.equal(cleanup.cleaned, false);
    assert.equal(existsSync(path.join(rootDir, cleanedAfterResidue.dispatch_id)), true);
    assert.equal(existsSync(path.join(rootDir, ".cleanup-retirement.json")), false);

    // A neighbor whose identity file exists but cannot be read might hold evidence that depends on
    // this dispatch, so cleanup keeps this dispatch instead of deleting under uncertainty. Writers
    // still proceed because they only re-read the dispatch they change.
    mkdirSync(path.join(rootDir, "dispatch-residue-corrupt"));
    writeFileSync(path.join(rootDir, "dispatch-residue-corrupt", "dispatch.json"), "{not json");
    await completeDispatch(helper, rootDir, behindCorruptNeighbor);
    assert.equal(existsSync(path.join(rootDir, behindCorruptNeighbor.dispatch_id, "completion-receipt.json")), true);
    const retained = await helper.cleanupDispatchEvidence({
      rootDir,
      dispatchId: behindCorruptNeighbor.dispatch_id,
      markerPresent: false,
      now: longAfter(),
    });
    assert.equal(retained.reason, "incomplete-evidence");
    assert.equal(existsSync(path.join(rootDir, behindCorruptNeighbor.dispatch_id)), true);

    // Only reservation reads other dispatches, to count capacity, so it stays fail-closed.
    await assert.rejects(
      () => helper.reserveDispatchRecord({ rootDir, record: unrelatedDispatch(9105) }),
      (error) => /capacity/i.test(String(error?.classification ?? ""))
    );
  });
});

test("control-evidence helper claims an existing renderer reservation exactly once without recreating it", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    assert.equal(typeof helper.reserveDispatchRecord, "function");
    assert.equal(typeof helper.claimDispatchInvocation, "function");

    const reserved = await helper.reserveDispatchRecord({ rootDir, record: dispatchRecord() });
    const dispatchBytes = readFileSync(reserved.path);
    const claimed = await helper.claimDispatchInvocation({ rootDir, record: dispatchRecord() });
    assert.equal(claimed.status, "created");
    assert.match(claimed.path, /invocation-claim\.json$/);
    assert.deepEqual(
      readFileSync(reserved.path),
      dispatchBytes,
      "runner claim must validate the renderer reservation instead of recreating or rewriting it"
    );

    await assert.rejects(
      () => helper.claimDispatchInvocation({ rootDir, record: dispatchRecord() }),
      (error) => error?.classification === "reviewer_dispatch_identity_collision"
    );
  });
});

test("control-evidence helper appends blocked consumption then separate supersession without rewriting", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    for (const name of [
      "reserveDispatchRecord",
      "writeFaultCapsule",
      "writeConsumptionReceipt",
      "writeSupersessionReceipt",
      "readDispatchEvidence",
    ]) {
      assert.equal(typeof helper[name], "function", `${name} must be exported`);
    }

    await helper.reserveDispatchRecord({ rootDir, record: dispatchRecord() });
    const capsule = await helper.writeFaultCapsule({
      rootDir,
      record: {
        ...dispatchRecord(),
        schema: "devpro-second-review-fault-capsule/v1",
        classification: "reviewer_orchestration_permission_denied",
        evidence_provenance: "provider_typed_event",
        evidence_confidence: "high",
        matcher_id: "claude.permission-denials.typed.v1",
        denied_action_class: "reviewer_sticky_write",
        redacted_excerpt: "Write action denied",
      },
    });
    assert.equal(capsule.status, "created");
    assert.match(capsule.record.integrity_id, /^[a-f0-9]{64}$/);
    assert.ok(Buffer.byteLength(readFileSync(capsule.path)) <= 16 * 1024);

    const consumption = await helper.writeConsumptionReceipt({
      rootDir,
      record: {
        ...dispatchRecord(),
        schema: "devpro-second-review-fault-consumption/v1",
        outcome: "blocked_orchestration_fault",
        capsule_integrity_id: capsule.record.integrity_id,
      },
    });
    const consumptionBytes = readFileSync(consumption.path);
    assert.ok(Buffer.byteLength(consumptionBytes) <= 4 * 1024);

    const successor = dispatchRecord({
      dispatch_id: "dispatch-1658-successor",
      previous_dispatch_id: "dispatch-1658-current",
      attempt_id: "second-review-pr-1658-abc123-successor",
    });
    await helper.reserveDispatchRecord({ rootDir, record: successor });
    await completeDispatch(helper, rootDir, successor);
    const supersession = await helper.writeSupersessionReceipt({
      rootDir,
      faultDispatchId: "dispatch-1658-current",
      record: {
        ...successor,
        schema: "devpro-second-review-fault-supersession/v1",
        fault_dispatch_id: "dispatch-1658-current",
        verified_dispatch_id: successor.dispatch_id,
        outcome: `superseded_by_verified_dispatch:${successor.dispatch_id}`,
        consumption_integrity_id: consumption.record.integrity_id,
      },
    });
    assert.ok(Buffer.byteLength(readFileSync(supersession.path)) <= 4 * 1024);
    assert.deepEqual(
      readFileSync(consumption.path),
      consumptionBytes,
      "successor verification must not rewrite the blocked consumption receipt"
    );
  });
});

test("control-evidence helper requires a terminal completion receipt before a successful cross-head successor", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    assert.equal(typeof helper.writeCompletionReceipt, "function");
    const prior = dispatchRecord({
      dispatch_id: "dispatch-completed-old-head",
      head_ref_oid: "abc123",
      attempt_id: "second-review-pr-1658-abc123-initial",
    });
    const successor = dispatchRecord({
      dispatch_id: "dispatch-successor-new-head",
      previous_dispatch_id: prior.dispatch_id,
      head_ref_oid: "def456",
      attempt_id: "second-review-pr-1658-def456-initial",
    });

    await helper.reserveDispatchRecord({ rootDir, record: prior });
    await helper.claimDispatchInvocation({ rootDir, record: prior });
    await assert.rejects(
      () => helper.reserveDispatchRecord({ rootDir, record: successor }),
      /terminal fault consumed|terminal completion receipt|successful completion receipt|closed terminal receipt/,
      "an invocation claim alone must not authorize a cross-head successor"
    );

    const completion = await helper.writeCompletionReceipt({
      rootDir,
      record: {
        ...prior,
        schema: helper.COMPLETION_SCHEMA,
        outcome: "reviewer_process_closed_and_sticky_verified",
        classification: "sticky_verified",
        sticky_verdict: "PASS",
        sticky_last_reviewed_sha: prior.head_ref_oid,
        sticky_dispatch_id: prior.dispatch_id,
        sticky_comment_id: 4242,
        sticky_comment_url: "https://github.com/devpro/example/pull/1658#issuecomment-4242",
        process_close_observed: true,
      },
    });
    assert.match(completion.path, /completion-receipt\.json$/);
    assert.equal(completion.record.schema, helper.COMPLETION_SCHEMA);

    const reserved = await reserveWithMarkerWitness(helper, rootDir, successor);
    assert.equal(reserved.status, "created");
    assert.equal(
      helper.readDispatchEvidence({ rootDir, dispatchId: prior.dispatch_id }).completion?.integrity_id,
      completion.record.integrity_id
    );
  });
});

test("legacy v1 completion receipt remains read-only valid for an existing closed predecessor", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const prior = dispatchRecord({
      dispatch_id: "dispatch-legacy-completion-old-head",
      head_ref_oid: "abc123",
      attempt_id: "second-review-pr-1658-abc123-initial",
    });
    const successor = dispatchRecord({
      dispatch_id: "dispatch-successor-after-legacy-completion",
      previous_dispatch_id: prior.dispatch_id,
      head_ref_oid: "def456",
      attempt_id: "second-review-pr-1658-def456-initial",
    });

    await helper.reserveDispatchRecord({ rootDir, record: prior });
    await helper.claimDispatchInvocation({ rootDir, record: prior });
    writeCanonicalEvidence(rootDir, prior.dispatch_id, "completion-receipt.json", {
      ...dispatchLifecycleIdentity(prior),
      schema: helper.LEGACY_COMPLETION_SCHEMA,
      outcome: "reviewer_process_closed_and_sticky_verified",
      classification: "sticky_verified",
      sticky_verdict: "PASS",
      sticky_last_reviewed_sha: prior.head_ref_oid,
      sticky_dispatch_id: prior.dispatch_id,
      process_close_observed: true,
    });

    const legacy = helper.readDispatchEvidence({ rootDir, dispatchId: prior.dispatch_id }).completion;
    assert.equal(legacy.schema, helper.LEGACY_COMPLETION_SCHEMA);
    const reserved = await reserveWithMarkerWitness(helper, rootDir, successor);
    assert.equal(reserved.status, "created");
  });
});

test("completion receipt binds the verified sticky comment id to its canonical PR URL", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const record = dispatchRecord({ dispatch_id: "dispatch-completion-url-mismatch" });
    await helper.reserveDispatchRecord({ rootDir, record });
    await helper.claimDispatchInvocation({ rootDir, record });

    await assert.rejects(
      () => helper.writeCompletionReceipt({
        rootDir,
        record: {
          ...record,
          schema: helper.COMPLETION_SCHEMA,
          outcome: "reviewer_process_closed_and_sticky_verified",
          classification: "sticky_verified",
          sticky_verdict: "PASS",
          sticky_last_reviewed_sha: record.head_ref_oid,
          sticky_dispatch_id: record.dispatch_id,
          sticky_comment_id: 4242,
          sticky_comment_url: "https://github.com/devpro/example/pull/1658#issuecomment-4243",
          process_close_observed: true,
        },
      }),
      /sticky binding is invalid/i
    );
    assert.equal(
      existsSync(path.join(rootDir, record.dispatch_id, "completion-receipt.json")),
      false,
      "a mismatched id/URL pair must not publish terminal success evidence"
    );
  });
});

test("closed terminal receipt authorizes a cross-head successor without weakening lifecycle identity", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const prior = dispatchRecord({
      dispatch_id: "dispatch-terminal-old-head",
      head_ref_oid: "abc123",
      attempt_id: "second-review-pr-1658-abc123-initial",
    });
    const successor = dispatchRecord({
      dispatch_id: "dispatch-terminal-new-head",
      previous_dispatch_id: prior.dispatch_id,
      head_ref_oid: "def456",
      attempt_id: "second-review-pr-1658-def456-initial",
    });

    await helper.reserveDispatchRecord({ rootDir, record: prior });
    const terminal = await closeDispatchWithTerminal(helper, rootDir, prior);
    assert.match(terminal.path, /terminal-receipt\.json$/);
    assert.equal(terminal.record.process_close_observed, true);
    assert.equal(terminal.record.transport_cleanup_confirmed, true);
    assert.equal(terminal.record.lifecycle_phase, "post_close_transport_cleaned");
    assert.match(terminal.record.invocation_claim_sha256, /^[a-f0-9]{64}$/);

    const reserved = await reserveWithMarkerWitness(helper, rootDir, successor);
    assert.equal(reserved.status, "created");
    assert.equal(
      helper.readDispatchEvidence({ rootDir, dispatchId: prior.dispatch_id }).terminal?.integrity_id,
      terminal.record.integrity_id
    );
  });
});

test("direct-predecessor reader rejects completion evidence without an invocation claim", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const prior = dispatchRecord({ dispatch_id: "dispatch-completion-without-claim" });
    const successor = dispatchRecord({
      dispatch_id: "dispatch-successor-rejects-unclaimed-completion",
      previous_dispatch_id: prior.dispatch_id,
      head_ref_oid: "def456",
      attempt_id: "second-review-pr-1658-def456-initial",
    });
    await helper.reserveDispatchRecord({ rootDir, record: prior });
    writeCanonicalEvidence(rootDir, prior.dispatch_id, "completion-receipt.json", {
      ...dispatchLifecycleIdentity(prior),
      schema: "devpro-second-review-completion/v1",
      outcome: "reviewer_process_closed_and_sticky_verified",
      classification: "sticky_verified",
      sticky_verdict: "PASS",
      sticky_last_reviewed_sha: prior.head_ref_oid,
      sticky_dispatch_id: prior.dispatch_id,
      process_close_observed: true,
    });

    await assert.rejects(
      () => helper.reserveDispatchRecord({ rootDir, record: successor }),
      /invocation claim/i
    );
  });
});

test("terminal receipt remains bounded, integrity-checked, and exclusive with completion or fault evidence", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const prior = dispatchRecord({ dispatch_id: "dispatch-terminal-exclusive" });
    await helper.reserveDispatchRecord({ rootDir, record: prior });
    const terminal = await closeDispatchWithTerminal(helper, rootDir, prior, {
      classification: "reviewer_completion_unavailable",
    });
    assert.ok(Buffer.byteLength(readFileSync(terminal.path)) <= 4096);
    assert.equal(terminal.record.outcome_group, "reviewer_blocking_verdict");
    assert.equal(terminal.record.responsibility, "reviewer_invocation_lifecycle");
    assert.equal(terminal.record.created_at, "2026-07-18T00:00:00.000Z");

    await assert.rejects(
      () => helper.writeFaultCapsule({
        rootDir,
        record: {
          ...prior,
          schema: "devpro-second-review-fault-capsule/v1",
          classification: "reviewer_orchestration_unknown",
          evidence_provenance: "provider_candidate_unmatched",
          evidence_confidence: "indeterminate",
          matcher_id: "none",
          denied_action_class: "unknown",
          redacted_excerpt: "bounded candidate",
        },
      }),
      /terminal evidence|collision/i
    );

    writeCanonicalEvidence(rootDir, prior.dispatch_id, "completion-receipt.json", {
      ...dispatchLifecycleIdentity(prior),
      schema: helper.COMPLETION_SCHEMA,
      outcome: "reviewer_process_closed_and_sticky_verified",
      classification: "sticky_verified",
      sticky_verdict: "WARN",
      sticky_last_reviewed_sha: prior.head_ref_oid,
      sticky_dispatch_id: prior.dispatch_id,
      sticky_comment_id: 4242,
      sticky_comment_url: "https://github.com/devpro/example/pull/1658#issuecomment-4242",
      process_close_observed: true,
    });
    assert.throws(
      () => helper.readDispatchEvidence({ rootDir, dispatchId: prior.dispatch_id }),
      /mutually exclusive/i
    );

    rmSync(path.join(rootDir, prior.dispatch_id, "completion-receipt.json"));
    const original = readFileSync(terminal.path, "utf8");
    writeFileSync(terminal.path, original.replace(
      "reviewer_completion_unavailable",
      "reviewer_completion_critical"
    ));
    assert.throws(
      () => helper.readDispatchEvidence({ rootDir, dispatchId: prior.dispatch_id }),
      /integrity/i
    );

    const { integrity_id: _integrityId, ...terminalWithoutIntegrity } = terminal.record;
    writeCanonicalEvidence(rootDir, prior.dispatch_id, "terminal-receipt.json", {
      ...terminalWithoutIntegrity,
      unowned_extension: "must-fail-closed",
    });
    assert.throws(
      () => helper.readDispatchEvidence({ rootDir, dispatchId: prior.dispatch_id }),
      /exact canonical field set/i,
      "a recomputed integrity hash must not authorize fields outside the terminal schema"
    );
  });
});

test("pre-spawn closed terminal needs no invocation claim and accepts only probe or spawn failures", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const probe = dispatchRecord({ dispatch_id: "dispatch-probe-terminal" });
    await helper.reserveDispatchRecord({ rootDir, record: probe });
    const terminal = await closeDispatchWithTerminal(helper, rootDir, probe, {
      classification: "probe_malformed",
      lifecyclePhase: "pre_spawn_known_terminal",
      claim: false,
    });
    assert.equal(terminal.record.process_spawned, false);
    assert.equal(terminal.record.process_close_observed, false);
    assert.equal(terminal.record.transport_cleanup_confirmed, true);
    assert.equal(terminal.record.invocation_claim_sha256, null);
    assert.equal(
      helper.readDispatchEvidence({ rootDir, dispatchId: probe.dispatch_id }).invocationClaim,
      null
    );

    const discovery = dispatchRecord({ dispatch_id: "dispatch-tool-discovery-terminal" });
    await helper.reserveDispatchRecord({ rootDir, record: discovery });
    const discoveryTerminal = await closeDispatchWithTerminal(helper, rootDir, discovery, {
      classification: "tool_discovery_blocked",
      lifecyclePhase: "pre_spawn_known_terminal",
      claim: false,
    });
    assert.equal(discoveryTerminal.record.outcome_group, "spawn_or_probe_failure");
    assert.equal(discoveryTerminal.record.process_spawned, false);
    assert.equal(discoveryTerminal.record.process_close_observed, false);
    assert.equal(discoveryTerminal.record.transport_cleanup_confirmed, true);
    assert.equal(discoveryTerminal.record.invocation_claim_sha256, null);

    const invalid = dispatchRecord({ dispatch_id: "dispatch-invalid-not-started-terminal" });
    await helper.reserveDispatchRecord({ rootDir, record: invalid });
    await assert.rejects(
      () => helper.writeTerminalReceipt({
        rootDir,
        record: {
          ...invalid,
          schema: "devpro-second-review-closed-terminal/v1",
          outcome_group: "confirmed_timeout",
          classification: "reviewer_cli_timeout",
          responsibility: "reviewer_invocation_lifecycle",
          created_at: "2026-07-18T00:00:00.000Z",
          process_spawned: false,
          lifecycle_phase: "pre_spawn_known_terminal",
          process_close_observed: false,
          transport_cleanup_confirmed: true,
          invocation_claim_sha256: null,
        },
      }),
      /lifecycle closure/i
    );
  });
});

test("RED-4 sticky disposition rejection is a durable pre-probe terminal without an invocation claim", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const record = dispatchRecord({
      dispatch_id: "dispatch-sticky-disposition-blocked",
    });

    assert.equal(
      helper.terminalReceiptOutcomeGroup("sticky_write_disposition_blocked"),
      "spawn_or_probe_failure",
      "RED-4 needs one bounded terminal class for every pre-spawn disposition refusal"
    );
    await helper.reserveDispatchRecord({ rootDir, record });
    const terminal = await closeDispatchWithTerminal(helper, rootDir, record, {
      classification: "sticky_write_disposition_blocked",
      lifecyclePhase: "pre_spawn_known_terminal",
      claim: false,
    });

    assert.equal(terminal.record.process_spawned, false);
    assert.equal(terminal.record.lifecycle_phase, "pre_spawn_known_terminal");
    assert.equal(terminal.record.process_close_observed, false);
    assert.equal(terminal.record.transport_cleanup_confirmed, true);
    assert.equal(terminal.record.invocation_claim_sha256, null);
    assert.equal(
      existsSync(path.join(rootDir, record.dispatch_id, "invocation-claim.json")),
      false
    );
    const evidence = helper.readDispatchEvidence({
      rootDir,
      dispatchId: record.dispatch_id,
    });
    assert.equal(evidence.terminal.classification, "sticky_write_disposition_blocked");
    assert.equal(evidence.invocationClaim, null);
  });
});

test("spawn failure remains pre-spawn even when its single-attempt claim already exists", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const spawned = dispatchRecord({ dispatch_id: "dispatch-spawn-failed-terminal" });
    await helper.reserveDispatchRecord({ rootDir, record: spawned });
    const terminal = await closeDispatchWithTerminal(helper, rootDir, spawned, {
      classification: "reviewer_cli_spawn_failed",
      lifecyclePhase: "pre_spawn_known_terminal",
      claim: true,
    });
    assert.equal(terminal.record.process_spawned, false);
    assert.equal(terminal.record.lifecycle_phase, "pre_spawn_known_terminal");
    assert.equal(terminal.record.process_close_observed, false);
    assert.equal(terminal.record.transport_cleanup_confirmed, true);
    assert.equal(terminal.record.invocation_claim_sha256, null);
  });
});

test("closed-terminal evidence rejects group drift and an incorrect post-spawn claim digest", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const discoveryGroupMismatch = dispatchRecord({
      dispatch_id: "dispatch-tool-discovery-group-mismatch",
    });
    await helper.reserveDispatchRecord({ rootDir, record: discoveryGroupMismatch });
    writeCanonicalEvidence(
      rootDir,
      discoveryGroupMismatch.dispatch_id,
      "terminal-receipt.json",
      {
        ...dispatchLifecycleIdentity(discoveryGroupMismatch),
        schema: "devpro-second-review-closed-terminal/v1",
        outcome_group: "provider_blocked",
        classification: "tool_discovery_blocked",
        responsibility: "reviewer_invocation_lifecycle",
        created_at: "2026-07-18T00:00:00.000Z",
        process_spawned: false,
        lifecycle_phase: "pre_spawn_known_terminal",
        process_close_observed: false,
        transport_cleanup_confirmed: true,
        invocation_claim_sha256: null,
      }
    );
    assert.throws(
      () => helper.readDispatchEvidence({
        rootDir,
        dispatchId: discoveryGroupMismatch.dispatch_id,
      }),
      /outcome group|classification/i
    );
    rmSync(path.join(
      rootDir,
      discoveryGroupMismatch.dispatch_id,
      "terminal-receipt.json"
    ));

    const groupMismatch = dispatchRecord({ dispatch_id: "dispatch-terminal-group-mismatch" });
    await helper.reserveDispatchRecord({ rootDir, record: groupMismatch });
    const mismatchClaim = await helper.claimDispatchInvocation({ rootDir, record: groupMismatch });
    const mismatchClaimSha = createHash("sha256").update(readFileSync(mismatchClaim.path)).digest("hex");
    writeCanonicalEvidence(rootDir, groupMismatch.dispatch_id, "terminal-receipt.json", {
      ...dispatchLifecycleIdentity(groupMismatch),
      schema: "devpro-second-review-closed-terminal/v1",
      outcome_group: "provider_blocked",
      classification: "reviewer_completion_critical",
      responsibility: "reviewer_invocation_lifecycle",
      created_at: "2026-07-18T00:00:00.000Z",
      process_spawned: true,
      lifecycle_phase: "post_close_transport_cleaned",
      process_close_observed: true,
      transport_cleanup_confirmed: true,
      invocation_claim_sha256: mismatchClaimSha,
    });
    assert.throws(
      () => helper.readDispatchEvidence({ rootDir, dispatchId: groupMismatch.dispatch_id }),
      /outcome group|classification/i
    );
    rmSync(path.join(rootDir, groupMismatch.dispatch_id, "terminal-receipt.json"));

    const digestMismatch = dispatchRecord({ dispatch_id: "dispatch-terminal-claim-mismatch" });
    await helper.reserveDispatchRecord({ rootDir, record: digestMismatch });
    await helper.claimDispatchInvocation({ rootDir, record: digestMismatch });
    writeCanonicalEvidence(rootDir, digestMismatch.dispatch_id, "terminal-receipt.json", {
      ...dispatchLifecycleIdentity(digestMismatch),
      schema: "devpro-second-review-closed-terminal/v1",
      outcome_group: "reviewer_blocking_verdict",
      classification: "reviewer_completion_critical",
      responsibility: "reviewer_invocation_lifecycle",
      created_at: "2026-07-18T00:00:00.000Z",
      process_spawned: true,
      lifecycle_phase: "post_close_transport_cleaned",
      process_close_observed: true,
      transport_cleanup_confirmed: true,
      invocation_claim_sha256: "0".repeat(64),
    });
    assert.throws(
      () => helper.readDispatchEvidence({ rootDir, dispatchId: digestMismatch.dispatch_id }),
      /invocation claim.*sha256|claim binding/i
    );
  });
});

test("post-hoc reconciled closed-terminal evidence carries the same obligations as inline cleanup", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();

    // The post-hoc phase discloses *when* cleanup was confirmed, not a weaker
    // record class: the writer must accept it through the same field set, and
    // the claim-binding check must not treat it as an early-exit phase.
    const reconciled = dispatchRecord({ dispatch_id: "dispatch-terminal-reconciled" });
    await helper.reserveDispatchRecord({ rootDir, record: reconciled });
    const claimed = await helper.claimDispatchInvocation({ rootDir, record: reconciled });
    await helper.writeTerminalReceipt({
      rootDir,
      record: {
        ...reconciled,
        schema: "devpro-second-review-closed-terminal/v1",
        outcome_group: helper.terminalReceiptOutcomeGroup("reviewer_completion_critical"),
        classification: "reviewer_completion_critical",
        responsibility: "reviewer_invocation_lifecycle",
        created_at: "2026-07-18T00:00:00.000Z",
        process_spawned: true,
        lifecycle_phase: "post_close_transport_reconciled",
        process_close_observed: true,
        transport_cleanup_confirmed: true,
        invocation_claim_sha256: createHash("sha256")
          .update(readFileSync(claimed.path))
          .digest("hex"),
      },
    });
    const evidence = helper.readDispatchEvidence({ rootDir, dispatchId: reconciled.dispatch_id });
    assert.equal(evidence.terminal.lifecycle_phase, "post_close_transport_reconciled");
    assert.equal(evidence.terminal.schema, "devpro-second-review-closed-terminal/v1");
    assert.equal(Object.keys(evidence.terminal).length, 17);

    // Same phase, wrong digest: the phase must buy no exemption from claim binding.
    const drifted = dispatchRecord({ dispatch_id: "dispatch-terminal-reconciled-claim-drift" });
    await helper.reserveDispatchRecord({ rootDir, record: drifted });
    await helper.claimDispatchInvocation({ rootDir, record: drifted });
    writeCanonicalEvidence(rootDir, drifted.dispatch_id, "terminal-receipt.json", {
      ...dispatchLifecycleIdentity(drifted),
      schema: "devpro-second-review-closed-terminal/v1",
      outcome_group: "reviewer_blocking_verdict",
      classification: "reviewer_completion_critical",
      responsibility: "reviewer_invocation_lifecycle",
      created_at: "2026-07-18T00:00:00.000Z",
      process_spawned: true,
      lifecycle_phase: "post_close_transport_reconciled",
      process_close_observed: true,
      transport_cleanup_confirmed: true,
      invocation_claim_sha256: "0".repeat(64),
    });
    assert.throws(
      () => helper.readDispatchEvidence({ rootDir, dispatchId: drifted.dispatch_id }),
      /invocation claim.*sha256|claim binding/i
    );
  });
});

test("concurrent byte-identical closed-terminal writes accept exactly one authority record", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const record = dispatchRecord({ dispatch_id: "dispatch-terminal-duplicate-race" });
    await helper.reserveDispatchRecord({ rootDir, record });
    const claimed = await helper.claimDispatchInvocation({ rootDir, record });
    const invocationClaimSha256 = createHash("sha256")
      .update(readFileSync(claimed.path))
      .digest("hex");
    const terminalRecord = {
      ...record,
      schema: "devpro-second-review-closed-terminal/v1",
      outcome_group: "reviewer_blocking_verdict",
      classification: "reviewer_completion_critical",
      responsibility: "reviewer_invocation_lifecycle",
      created_at: "2026-07-18T00:00:00.000Z",
      process_spawned: true,
      lifecycle_phase: "post_close_transport_cleaned",
      process_close_observed: true,
      transport_cleanup_confirmed: true,
      invocation_claim_sha256: invocationClaimSha256,
    };

    const results = await Promise.allSettled([
      helper.writeTerminalReceipt({ rootDir, record: terminalRecord }),
      helper.writeTerminalReceipt({ rootDir, record: terminalRecord }),
    ]);
    assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
    assert.equal(results.filter(({ status }) => status === "rejected").length, 1);
  });
});

test("verified dispatch can supersede every older fault in its direct lineage", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const first = dispatchRecord({ dispatch_id: "dispatch-lineage-fault-1" });
    const second = dispatchRecord({
      dispatch_id: "dispatch-lineage-fault-2",
      previous_dispatch_id: first.dispatch_id,
      attempt_id: "second-review-pr-1658-abc123-fault-2",
    });
    const verified = dispatchRecord({
      dispatch_id: "dispatch-lineage-verified",
      previous_dispatch_id: second.dispatch_id,
      attempt_id: "second-review-pr-1658-abc123-verified",
    });

    const consumed = new Map();
    for (const record of [first, second]) {
      await helper.reserveDispatchRecord({ rootDir, record });
      const capsule = await helper.writeFaultCapsule({
        rootDir,
        record: {
          ...record,
          schema: "devpro-second-review-fault-capsule/v1",
          classification: "reviewer_orchestration_unknown",
          evidence_provenance: "provider_candidate_unmatched",
          evidence_confidence: "indeterminate",
          matcher_id: "none",
          denied_action_class: "unknown",
          redacted_excerpt: "bounded candidate",
        },
      });
      const receipt = await helper.writeConsumptionReceipt({
        rootDir,
        record: {
          ...record,
          schema: "devpro-second-review-fault-consumption/v1",
          outcome: "blocked_orchestration_fault",
          capsule_integrity_id: capsule.record.integrity_id,
        },
      });
      consumed.set(record.dispatch_id, receipt.record.integrity_id);
    }
    await reserveWithMarkerWitness(helper, rootDir, verified);
    await completeDispatch(helper, rootDir, verified, "WARN");

    for (const fault of [first, second]) {
      const receipt = await helper.writeSupersessionReceipt({
        rootDir,
        faultDispatchId: fault.dispatch_id,
        record: {
          ...verified,
          schema: "devpro-second-review-fault-supersession/v1",
          fault_dispatch_id: fault.dispatch_id,
          verified_dispatch_id: verified.dispatch_id,
          outcome: `superseded_by_verified_dispatch:${verified.dispatch_id}`,
          consumption_integrity_id: consumed.get(fault.dispatch_id),
        },
      });
      assert.equal(receipt.record.fault_dispatch_id, fault.dispatch_id);
    }
  });
});

test("fault provenance metadata is bounded by UTF-8 bytes before immutable publish", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const base = dispatchRecord();
    await helper.reserveDispatchRecord({ rootDir, record: base });
    const capsule = await helper.writeFaultCapsule({
      rootDir,
      record: {
        ...base,
        schema: "devpro-second-review-fault-capsule/v1",
        classification: "reviewer_orchestration_unknown",
        evidence_provenance: "界".repeat(256),
        evidence_confidence: "indeterminate",
        matcher_id: "none",
        denied_action_class: "unknown",
        redacted_excerpt: "bounded candidate",
      },
    });
    const evidence = helper.readDispatchEvidence({ rootDir, dispatchId: base.dispatch_id });
    assert.equal(evidence.capsule.integrity_id, capsule.record.integrity_id);
    assert.ok(Buffer.byteLength(evidence.capsule.evidence_provenance, "utf8") <= 256);
  });
});

test("control-evidence helper rejects missing, corrupt, tampered, and identity-mismatched capsules", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const base = dispatchRecord();
    await helper.reserveDispatchRecord({ rootDir, record: base });
    const missingReceipt = {
      ...base,
      schema: "devpro-second-review-fault-consumption/v1",
      outcome: "blocked_orchestration_fault",
      capsule_integrity_id: "0".repeat(64),
    };
    await assert.rejects(
      () => helper.writeConsumptionReceipt({ rootDir, record: missingReceipt }),
      (error) => error?.classification === "reviewer_dispatch_identity_collision"
    );

    const capsule = await helper.writeFaultCapsule({
      rootDir,
      record: {
        ...base,
        schema: "devpro-second-review-fault-capsule/v1",
        classification: "reviewer_orchestration_unknown",
        evidence_provenance: "provider_candidate_unmatched",
        evidence_confidence: "indeterminate",
        matcher_id: "none",
        denied_action_class: "unknown",
        redacted_excerpt: "bounded candidate",
      },
    });
    const validBytes = readFileSync(capsule.path);
    const parsed = JSON.parse(validBytes);
    writeFileSync(capsule.path, `${JSON.stringify({ ...parsed, redacted_excerpt: "tampered" })}\n`);
    assert.throws(
      () => helper.readDispatchEvidence({ rootDir, dispatchId: base.dispatch_id }),
      (error) => error?.classification === "reviewer_dispatch_identity_collision"
    );

    writeFileSync(capsule.path, "{not-json\n");
    assert.throws(
      () => helper.readDispatchEvidence({ rootDir, dispatchId: base.dispatch_id }),
      (error) => error?.classification === "reviewer_dispatch_identity_collision"
    );

    writeFileSync(capsule.path, validBytes);
    await assert.rejects(
      () => helper.writeConsumptionReceipt({
        rootDir,
        record: {
          ...missingReceipt,
          repository_slug: "different/repository",
          capsule_integrity_id: parsed.integrity_id,
        },
      }),
      (error) => error?.classification === "reviewer_dispatch_identity_collision"
    );
  });
});

test("control-evidence cleanup never time-deletes an unconsumed capsule", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    assert.equal(typeof helper.cleanupDispatchEvidence, "function");
    await helper.reserveDispatchRecord({ rootDir, record: dispatchRecord() });
    const capsule = await helper.writeFaultCapsule({
      rootDir,
      record: {
        ...dispatchRecord(),
        schema: "devpro-second-review-fault-capsule/v1",
        classification: "reviewer_orchestration_unknown",
        evidence_provenance: "provider_candidate_unmatched",
        evidence_confidence: "indeterminate",
        matcher_id: "none",
        denied_action_class: "unknown",
        redacted_excerpt: "unapproved candidate shape",
      },
    });

    const cleanup = await helper.cleanupDispatchEvidence({
      rootDir,
      dispatchId: "dispatch-1658-current",
      markerPresent: false,
      now: Date.now() + 365 * 24 * 60 * 60 * 1000,
    });
    assert.equal(cleanup.eligible, false);
    assert.equal(cleanup.reason, "unconsumed");
    assert.equal(existsSync(capsule.path), true);
  });
});

test("consumed fault remains independently fail-closed after capsule-only cleanup", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const base = dispatchRecord();
    await helper.reserveDispatchRecord({ rootDir, record: base });
    const capsule = await helper.writeFaultCapsule({
      rootDir,
      record: {
        ...base,
        schema: "devpro-second-review-fault-capsule/v1",
        classification: "reviewer_orchestration_unknown",
        evidence_provenance: "provider_candidate_unmatched",
        evidence_confidence: "indeterminate",
        matcher_id: "none",
        denied_action_class: "unknown",
        redacted_excerpt: "unapproved candidate shape",
      },
    });
    const consumption = await helper.writeConsumptionReceipt({
      rootDir,
      record: {
        ...base,
        schema: "devpro-second-review-fault-consumption/v1",
        outcome: "blocked_orchestration_fault",
        capsule_integrity_id: capsule.record.integrity_id,
      },
    });

    const cleanup = await helper.cleanupDispatchEvidence({
      rootDir,
      dispatchId: base.dispatch_id,
      markerPresent: true,
    });
    assert.deepEqual(cleanup, {
      eligible: true,
      cleaned: true,
      reason: "cleaned",
      scope: "capsule-only",
    });
    assert.equal(existsSync(capsule.path), false, "cleanup owner must remove the consumed capsule");

    const receiptOnly = helper.readDispatchEvidence({
      rootDir,
      dispatchId: base.dispatch_id,
    });
    assert.equal(receiptOnly.capsule, null);
    assert.equal(receiptOnly.consumption.classification, capsule.record.classification);
    assert.equal(receiptOnly.consumption.responsibility, capsule.record.responsibility);
    assert.equal(receiptOnly.consumption.capsule_integrity_id, capsule.record.integrity_id);

    const repeated = await helper.writeConsumptionReceipt({
      rootDir,
      record: {
        ...base,
        schema: "devpro-second-review-fault-consumption/v1",
        outcome: "blocked_orchestration_fault",
        classification: capsule.record.classification,
        responsibility: capsule.record.responsibility,
        capsule_integrity_id: capsule.record.integrity_id,
      },
    });
    assert.equal(repeated.status, "idempotent");
    assert.equal(repeated.record.integrity_id, consumption.record.integrity_id);

    const markerCleanup = await helper.cleanupDispatchEvidence({
      rootDir,
      dispatchId: base.dispatch_id,
      markerPresent: true,
      now: Date.now() + 365 * 24 * 60 * 60 * 1000,
    });
    assert.deepEqual(markerCleanup, {
      eligible: false,
      cleaned: false,
      reason: "capsule-already-cleaned",
      scope: "capsule-only",
    });
    assert.equal(existsSync(consumption.path), true, "marker-present cleanup must preserve the receipt");
  });
});

test("cleanup owner preserves marker-bound receipts, then removes a mature complete chain in dependency order", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    assert.equal(typeof helper.cleanupOwnedControlEvidence, "function");
    const fault = dispatchRecord({ dispatch_id: "dispatch-cleanup-fault" });
    const verified = dispatchRecord({
      dispatch_id: "dispatch-cleanup-verified",
      previous_dispatch_id: fault.dispatch_id,
      head_ref_oid: "def456",
      attempt_id: "second-review-pr-1658-def456-initial",
    });
    await helper.reserveDispatchRecord({ rootDir, record: fault });
    await helper.claimDispatchInvocation({ rootDir, record: fault });
    const capsule = await helper.writeFaultCapsule({
      rootDir,
      record: {
        ...fault,
        schema: "devpro-second-review-fault-capsule/v1",
        classification: "reviewer_orchestration_unknown",
        evidence_provenance: "provider_candidate_unmatched",
        evidence_confidence: "indeterminate",
        matcher_id: "none",
        denied_action_class: "unknown",
        redacted_excerpt: "bounded candidate",
      },
    });
    const consumption = await helper.writeConsumptionReceipt({
      rootDir,
      record: {
        ...fault,
        schema: "devpro-second-review-fault-consumption/v1",
        outcome: "blocked_orchestration_fault",
        capsule_integrity_id: capsule.record.integrity_id,
      },
    });
    await reserveWithMarkerWitness(helper, rootDir, verified);
    await completeDispatch(helper, rootDir, verified);
    const supersession = await helper.writeSupersessionReceipt({
      rootDir,
      faultDispatchId: fault.dispatch_id,
      record: {
        ...verified,
        schema: "devpro-second-review-fault-supersession/v1",
        fault_dispatch_id: fault.dispatch_id,
        verified_dispatch_id: verified.dispatch_id,
        outcome: `superseded_by_verified_dispatch:${verified.dispatch_id}`,
        consumption_integrity_id: consumption.record.integrity_id,
      },
    });
    const ownerNow = Date.now() + 3 * 60 * 60_000;
    const activeMarker = {
      repository_slug: verified.repository_slug,
      prNumber: verified.pr_number,
      head_ref_oid: verified.head_ref_oid,
      expected_dispatch_id: verified.dispatch_id,
    };

    const protectedRun = await helper.cleanupOwnedControlEvidence({
      rootDir,
      activeMarkers: [activeMarker],
      now: ownerNow,
    });
    assert.equal(protectedRun.cleanedCapsules, 1);
    assert.equal(protectedRun.cleanedDirectories, 0);
    assert.equal(existsSync(capsule.path), false, "valid consumption permits capsule-only cleanup");
    assert.equal(existsSync(consumption.path), true, "marker must preserve consumption receipt");
    assert.equal(existsSync(supersession.path), true, "marker must preserve supersession receipt");
    assert.equal(
      existsSync(path.join(rootDir, fault.dispatch_id)),
      true,
      "an active new-head marker must preserve its consumed old-head ancestor"
    );
    assert.equal(existsSync(path.join(rootDir, verified.dispatch_id)), true);

    const markerClearedRun = await helper.cleanupOwnedControlEvidence({
      rootDir,
      activeMarkers: [],
      now: ownerNow,
    });
    assert.equal(markerClearedRun.cleanedDirectories, 2);
    assert.equal(
      existsSync(path.join(rootDir, fault.dispatch_id)),
      false,
      "complete superseded fault chain must be removed first"
    );
    assert.equal(
      existsSync(path.join(rootDir, verified.dispatch_id)),
      false,
      "marker-cleared successful current dispatch must then be removed"
    );
  });
});

test("cleanup owner treats a mature closed terminal receipt as a removable complete lifecycle", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const record = dispatchRecord({ dispatch_id: "dispatch-terminal-cleanup" });
    await helper.reserveDispatchRecord({ rootDir, record });
    await closeDispatchWithTerminal(helper, rootDir, record);

    const cleanup = await helper.cleanupDispatchEvidence({
      rootDir,
      dispatchId: record.dispatch_id,
      markerPresent: false,
      now: Date.now() + 3 * 60 * 60_000,
    });
    assert.deepEqual(cleanup, {
      eligible: true,
      cleaned: true,
      reason: "cleaned",
      scope: "complete-chain-directory",
    });
    assert.equal(existsSync(path.join(rootDir, record.dispatch_id)), false);
  });
});

test("capacity mutex never steals a live owner even after the stale threshold", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const release = helper.acquireCapacityLockForTest(rootDir, {
      waitMs: 20,
      staleAfterMs: 0,
    });
    assert.throws(
      () => helper.acquireCapacityLockForTest(rootDir, {
        waitMs: 20,
        staleAfterMs: 0,
      }),
      /capacity gate is unavailable/i
    );
    assert.equal(existsSync(path.join(rootDir, ".capacity-lock", "owner.json")), true);
    release();
    assert.equal(existsSync(path.join(rootDir, ".capacity-lock")), false);
  });
});

test("capacity mutex recovers an exact stale dead owner and durably releases its replacement", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const lockPath = path.join(rootDir, ".capacity-lock");
    mkdirSync(lockPath, { mode: 0o700 });
    writeFileSync(path.join(lockPath, "owner.json"), `${JSON.stringify({
      schema: "devpro-second-review-capacity-lock/v1",
      owner_pid: 2147483647,
      owner_token: "00000000-0000-4000-8000-000000000001",
      created_at: "1970-01-01T00:00:00.000Z",
    })}\n`);

    const release = helper.acquireCapacityLockForTest(rootDir, {
      waitMs: 50,
      staleAfterMs: 0,
    });
    const replacement = JSON.parse(readFileSync(path.join(lockPath, "owner.json"), "utf8"));
    assert.equal(replacement.owner_pid, process.pid);
    assert.notEqual(replacement.owner_token, "00000000-0000-4000-8000-000000000001");
    release();
    assert.equal(existsSync(lockPath), false);
  });
});

// An existing lock directory whose owner record is missing or malformed is undecidable: the
// failure keeps the evidence and names the entry to remove by hand (design D7).
const UNDECIDABLE_CAPACITY_LOCK_MESSAGE = "dispatch capacity gate is unavailable; reservation failed closed; \".capacity-lock\" in the control-evidence root (notes/tmp/state/devpro-second-review-control-evidence under the main checkout, or DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR when set) has no valid owner record; remove it manually once no reviewer dispatch is running";

test("capacity mutex preserves stale malformed owner evidence and fails closed", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const lockPath = path.join(rootDir, ".capacity-lock");
    const ownerPath = path.join(lockPath, "owner.json");
    const malformedBytes = Buffer.from('{"schema":"incomplete"}\n');
    mkdirSync(lockPath, { mode: 0o700 });
    writeFileSync(ownerPath, malformedBytes);
    utimesSync(lockPath, new Date(0), new Date(0));

    assert.throws(
      () => helper.acquireCapacityLockForTest(rootDir, {
        waitMs: 0,
        staleAfterMs: 0,
      }),
      (error) => {
        assert.equal(error.message, UNDECIDABLE_CAPACITY_LOCK_MESSAGE);
        assert.equal(error.classification, "reviewer_dispatch_capacity_exceeded");
        return true;
      }
    );
    assert.equal(existsSync(lockPath), true, "stale malformed owner directory must remain");
    assert.deepEqual(readFileSync(ownerPath), malformedBytes, "malformed owner bytes must remain intact");
  });
});

test("capacity mutex preserves stale missing owner evidence and fails closed", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const lockPath = path.join(rootDir, ".capacity-lock");
    mkdirSync(lockPath, { mode: 0o700 });
    utimesSync(lockPath, new Date(0), new Date(0));

    assert.throws(
      () => helper.acquireCapacityLockForTest(rootDir, {
        waitMs: 0,
        staleAfterMs: 0,
      }),
      (error) => {
        assert.equal(error.message, UNDECIDABLE_CAPACITY_LOCK_MESSAGE);
        assert.equal(error.classification, "reviewer_dispatch_capacity_exceeded");
        return true;
      }
    );
    assert.equal(existsSync(lockPath), true, "stale lock with missing owner must remain");
    assert.deepEqual(readdirSync(lockPath), [], "owner absence must remain unchanged");
  });
});

test("capacity mutex fails closed for a fresh malformed owner and for release ownership mismatch", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const lockPath = path.join(rootDir, ".capacity-lock");
    mkdirSync(lockPath, { mode: 0o700 });
    writeFileSync(path.join(lockPath, "owner.json"), "{\"schema\":\"incomplete\"}\n");
    assert.throws(
      () => helper.acquireCapacityLockForTest(rootDir, {
        waitMs: 20,
        staleAfterMs: 60_000,
      }),
      /capacity gate is unavailable/i
    );
    assert.equal(existsSync(lockPath), true, "fresh malformed evidence must not be stolen");

    rmSync(lockPath, { recursive: true, force: true });
    const release = helper.acquireCapacityLockForTest(rootDir, { waitMs: 20 });
    const ownerPath = path.join(lockPath, "owner.json");
    const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
    const originalBytes = readFileSync(ownerPath);
    writeFileSync(ownerPath, `${JSON.stringify({
      ...owner,
      owner_token: "00000000-0000-4000-8000-000000000002",
    })}\n`);
    assert.throws(release, /ownership mismatch/i);
    assert.equal(existsSync(lockPath), true, "mismatched release must preserve the current owner");

    writeFileSync(ownerPath, originalBytes);
    release();
    assert.equal(existsSync(lockPath), false);
  });
});

test("dispatch record assertion rejects absolute carrier paths and malformed carrier root digests", async () => {
  const helper = await loadHelper();
  const digest = createHash("sha256")
    .update(Buffer.from("/repo/notes/cross-review/second-review-pr-1735-initial", "utf8"))
    .digest("hex");
  const canonical = {
    ...dispatchRecord(),
    packet_sha256: "a".repeat(64),
    carrier_root_id: digest,
  };

  assert.equal(helper.assertSecondReviewDispatchRecord(canonical), canonical);

  // A pre-fix record — or any future edit that re-adds a path field — must be
  // rejected by the exact-field-set check, not silently accepted. The dispatch
  // store lives under the reviewer-writable root, so a leaked absolute carrier
  // path there undoes the relocation this record's digest replaced.
  assert.throws(
    () => helper.assertSecondReviewDispatchRecord({
      ...canonical,
      packet_path: "/repo/notes/cross-review/second-review-pr-1735-initial/packet.md",
    }),
    /exact canonical field set/
  );
  assert.throws(
    () => helper.assertSecondReviewDispatchRecord(
      Object.fromEntries(Object.entries(canonical).filter(([key]) => key !== "carrier_root_id"))
    ),
    /exact canonical field set/
  );

  for (const invalid of ["", "not-a-digest", digest.toUpperCase(), digest.slice(0, 63), `${digest}0`]) {
    assert.throws(
      () => helper.assertSecondReviewDispatchRecord({ ...canonical, carrier_root_id: invalid }),
      /carrier_root_id is invalid/,
      `carrier_root_id ${JSON.stringify(invalid)} must be rejected`
    );
  }
});

test("reservation, read, and rollback share exact v4-or-v5 validation with canonical lifetime bytes", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const v4 = dispatchRecord({ dispatch_id: "dispatch-exact-v4-compatible" });
    assert.equal((await helper.reserveDispatchRecord({ rootDir, record: v4 })).status, "created");
    assert.equal(helper.verifyDispatchReservation({ rootDir, record: v4 }).status, "verified");
    assert.equal(helper.rollbackUnclaimedDispatchReservation({ rootDir, record: v4 }).status, "rolled-back");

    const v5 = dispatchRecord({
      dispatch_id: "dispatch-exact-v5-compatible",
      paged_full_material_sha256: "c".repeat(64),
      paged_full_material_created_at: "2026-08-13T00:00:00.000Z",
      paged_full_material_expires_at: "2026-08-13T02:00:00.000Z",
    });
    assert.equal((await helper.reserveDispatchRecord({ rootDir, record: v5 })).status, "created");
    assert.equal(helper.verifyDispatchReservation({ rootDir, record: v5 }).status, "verified");
    assert.equal(helper.rollbackUnclaimedDispatchReservation({ rootDir, record: v5 }).status, "rolled-back");

    for (const invalid of [
      { ...v5, dispatch_id: "dispatch-noncanonical-created", paged_full_material_created_at: "2026-08-13T00:00:00Z" },
      { ...v5, dispatch_id: "dispatch-noncanonical-expires", paged_full_material_expires_at: "2026-08-13T02:00:00Z" },
      { ...v5, dispatch_id: "dispatch-wrong-lifetime", paged_full_material_expires_at: "2026-08-13T02:00:00.001Z" },
    ]) {
      await assert.rejects(
        () => helper.reserveDispatchRecord({ rootDir, record: invalid }),
        /lifetime is invalid/,
      );
      assert.throws(
        () => helper.rollbackUnclaimedDispatchReservation({ rootDir, record: invalid }),
        /lifetime is invalid/,
      );
    }

    const corrupt = {
      ...v5,
      dispatch_id: "dispatch-exact-read-corrupt",
      paged_full_material_created_at: "2026-08-13T00:00:00Z",
    };
    const corruptDir = path.join(rootDir, corrupt.dispatch_id);
    mkdirSync(corruptDir, { recursive: true });
    writeFileSync(path.join(corruptDir, "dispatch.json"), `${JSON.stringify(corrupt)}\n`);
    const successor = dispatchRecord({
      dispatch_id: "dispatch-exact-read-successor",
      previous_dispatch_id: corrupt.dispatch_id,
    });
    await assert.rejects(
      () => helper.reserveDispatchRecord({ rootDir, record: successor }),
      /lifetime is invalid/,
    );
  });
});

// T16 (Part B5/B8, R6): capacityLockOwnerIsAlive is promoted from module-private to an
// exported symbol so run-second-reviewer-projection.mjs's reviewer-home scavenging can
// reuse this exact liveness semantic (EPERM/unknown treated as live, only ESRCH is
// dead) instead of growing a second `process.kill(pid, 0)` implementation.
test("T16: capacityLockOwnerIsAlive is exported and preserves its live/dead liveness semantics", async () => {
  const helper = await loadHelper();
  assert.equal(typeof helper.capacityLockOwnerIsAlive, "function");
  assert.equal(helper.capacityLockOwnerIsAlive(process.pid), true, "the current process must read as alive");

  const deadPidResult = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  assert.equal(deadPidResult.status, 0, deadPidResult.stderr);
  assert.ok(Number.isInteger(deadPidResult.pid), "spawnSync should expose child pid");
  assert.equal(
    helper.capacityLockOwnerIsAlive(deadPidResult.pid),
    false,
    "an exited child's pid must read as dead (ESRCH)",
  );
});

// The two existing call sites (recoverStaleCapacityLock / acquireCapacityLock) are
// unmodified by this promotion — the pre-existing "capacity mutex recovers an exact
// stale dead owner..." and neighboring tests above already exercise their live/dead/
// unknown branches through the same public acquireCapacityLockForTest() surface and
// continue to pass unchanged, which is the identical-semantics evidence for those two
// sites (adding a duplicate assertion here would just retest what those already cover).

test("audit-only none and no-sha reservations do not share the PR/head 16-slot cap", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    for (const sentinel of ["none", "no-sha"]) {
      for (let index = 0; index < 16; index += 1) {
        await helper.reserveDispatchRecord({
          rootDir,
          record: dispatchRecord({
            pr_number: "none",
            head_ref_oid: sentinel,
            attempt_id: `second-review-audit-${sentinel}-${index}`,
            dispatch_id: `dispatch-audit-${sentinel}-${index}`,
          }),
        });
      }
      const seventeenth = await helper.reserveDispatchRecord({
        rootDir,
        record: dispatchRecord({
          pr_number: "none",
          head_ref_oid: sentinel,
          attempt_id: `second-review-audit-${sentinel}-17`,
          dispatch_id: `dispatch-audit-${sentinel}-17`,
        }),
      });
      assert.equal(seventeenth.status, "created");
    }
  });
});

test("mixed-case historical 40-hex SHA shares the canonical PR/head 16-slot bucket", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    for (let index = 0; index < 15; index += 1) {
      await helper.reserveDispatchRecord({
        rootDir,
        record: dispatchRecord({
          head_ref_oid: CANONICAL_HEAD_SHA,
          attempt_id: `second-review-pr-1658-canonical-${index}`,
          dispatch_id: `dispatch-1658-canonical-${index}`,
        }),
      });
    }
    plantDispatchRecord(rootDir, dispatchRecord({
      head_ref_oid: MIXED_CASE_HEAD_SHA,
      attempt_id: "second-review-pr-1658-mixed-historical",
      dispatch_id: "dispatch-1658-mixed-historical",
    }));

    await assert.rejects(
      () => helper.reserveDispatchRecord({
        rootDir,
        record: dispatchRecord({
          head_ref_oid: CANONICAL_HEAD_SHA,
          attempt_id: "second-review-pr-1658-canonical-16",
          dispatch_id: "dispatch-1658-canonical-16",
        }),
      }),
      (error) => error?.classification === "reviewer_dispatch_capacity_exceeded"
        && /PR\/head dispatch capacity is 16/.test(String(error?.message ?? "")),
    );
  });
});

test("new writes reject mixed-case or uppercase 40-hex head_ref_oid", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    for (const headRefOid of [MIXED_CASE_HEAD_SHA, CANONICAL_HEAD_SHA.toUpperCase()]) {
      await assert.rejects(
        () => helper.reserveDispatchRecord({
          rootDir,
          record: dispatchRecord({
            head_ref_oid: headRefOid,
            attempt_id: `second-review-pr-1658-new-${headRefOid.slice(0, 8)}`,
            dispatch_id: `dispatch-1658-new-${headRefOid.slice(0, 8)}`,
          }),
        }),
        (error) => error?.classification === "reviewer_dispatch_identity_collision",
      );
    }
  });
});

test("writeCompletionReceipt persists audit-only field-set and rejects sticky sentinels", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const record = dispatchRecord({
      pr_number: "none",
      head_ref_oid: "none",
      attempt_id: "second-review-audit-receipt",
      dispatch_id: "dispatch-audit-receipt",
    });
    await helper.reserveDispatchRecord({ rootDir, record });
    await helper.claimDispatchInvocation({ rootDir, record });

    const completion = await helper.writeCompletionReceipt({
      rootDir,
      record: auditCompletionInput(record),
    });
    assert.match(completion.path, /completion-receipt\.json$/);
    assert.equal(completion.record.schema, helper.COMPLETION_SCHEMA);
    assert.equal(completion.record.outcome, "reviewer_process_closed_audit_only");
    assert.equal(completion.record.classification, "audit_only_verified");
    assert.equal(completion.record.pr_number, "none");
    assert.equal(completion.record.process_close_observed, true);
    assert.deepEqual(Object.keys(completion.record).sort(), [...AUDIT_COMPLETION_FIELDS].sort());
    assert.equal(
      Object.keys(completion.record).some((key) => key.startsWith("sticky_")),
      false,
    );

    const withRestId = dispatchRecord({
      pr_number: "none",
      head_ref_oid: "none",
      attempt_id: "second-review-audit-fake-sticky-id",
      dispatch_id: "dispatch-audit-fake-sticky-id",
    });
    await helper.reserveDispatchRecord({ rootDir, record: withRestId });
    await helper.claimDispatchInvocation({ rootDir, record: withRestId });
    for (const stickyCommentId of [4242, "none", 0]) {
      await assert.rejects(
        () => helper.writeCompletionReceipt({
          rootDir,
          record: auditCompletionInput(withRestId, {
            sticky_comment_id: stickyCommentId,
            sticky_comment_url: "none",
          }),
        }),
        (error) => error?.classification === "reviewer_dispatch_identity_collision",
      );
    }
  });
});

test("pr-sticky completion still requires a positive sticky_comment_id", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const record = dispatchRecord({ dispatch_id: "dispatch-sticky-missing-rest-id" });
    await helper.reserveDispatchRecord({ rootDir, record });
    await helper.claimDispatchInvocation({ rootDir, record });
    await assert.rejects(
      () => helper.writeCompletionReceipt({
        rootDir,
        record: {
          ...dispatchLifecycleIdentity(record),
          schema: helper.COMPLETION_SCHEMA,
          outcome: "reviewer_process_closed_and_sticky_verified",
          classification: "sticky_verified",
          sticky_verdict: "PASS",
          sticky_last_reviewed_sha: record.head_ref_oid,
          sticky_dispatch_id: record.dispatch_id,
          process_close_observed: true,
        },
      }),
      (error) => error?.classification === "reviewer_dispatch_identity_collision",
    );
    assert.equal(
      existsSync(path.join(rootDir, record.dispatch_id, "completion-receipt.json")),
      false,
    );
  });
});

test("two independent audit-only successes persist separate completion receipts", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const receipts = [];
    for (const suffix of ["first", "second"]) {
      const record = dispatchRecord({
        pr_number: "none",
        head_ref_oid: "none",
        attempt_id: `second-review-audit-independent-${suffix}`,
        dispatch_id: `dispatch-audit-independent-${suffix}`,
      });
      await helper.reserveDispatchRecord({ rootDir, record });
      await helper.claimDispatchInvocation({ rootDir, record });
      receipts.push(await helper.writeCompletionReceipt({
        rootDir,
        record: auditCompletionInput(record),
      }));
    }
    assert.equal(receipts[0].path === receipts[1].path, false);
    for (const completion of receipts) {
      assert.equal(existsSync(completion.path), true);
      assert.equal(completion.record.classification, "audit_only_verified");
      assert.equal(
        Object.keys(completion.record).some((key) => key.startsWith("sticky_")),
        false,
      );
    }
  });
});

test("real-PR successor must not treat an audit-only receipt as a closed predecessor", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const prior = dispatchRecord({
      pr_number: "none",
      head_ref_oid: "none",
      attempt_id: "second-review-audit-predecessor",
      dispatch_id: "dispatch-audit-predecessor",
    });
    await helper.reserveDispatchRecord({ rootDir, record: prior });
    await helper.claimDispatchInvocation({ rootDir, record: prior });
    await helper.writeCompletionReceipt({
      rootDir,
      record: auditCompletionInput(prior),
    });

    await assert.rejects(
      () => helper.reserveDispatchRecord({
        rootDir,
        record: dispatchRecord({
          previous_dispatch_id: prior.dispatch_id,
          attempt_id: "second-review-pr-successor-after-audit",
          dispatch_id: "dispatch-pr-successor-after-audit",
        }),
      }),
      (error) => error?.classification === "reviewer_dispatch_identity_collision",
    );
  });
});

test("audit-only reservations with a real SHA do not share a none-plus-SHA 16-slot bucket", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    for (let index = 0; index < 16; index += 1) {
      await helper.reserveDispatchRecord({
        rootDir,
        record: dispatchRecord({
          pr_number: "none",
          head_ref_oid: CANONICAL_HEAD_SHA,
          attempt_id: `second-review-audit-sha-${index}`,
          dispatch_id: `dispatch-audit-sha-${index}`,
        }),
      });
    }
    const seventeenth = await helper.reserveDispatchRecord({
      rootDir,
      record: dispatchRecord({
        pr_number: "none",
        head_ref_oid: CANONICAL_HEAD_SHA,
        attempt_id: "second-review-audit-sha-17",
        dispatch_id: "dispatch-audit-sha-17",
      }),
    });
    assert.equal(seventeenth.status, "created");
  });
});

test("usage-manifest companion does not block marker-free complete-chain TTL cleanup", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const record = dispatchRecord({ dispatch_id: "dispatch-cleanup-with-manifest" });
    await helper.reserveDispatchRecord({ rootDir, record });
    await completeDispatch(helper, rootDir, record);
    const manifestPath = path.join(rootDir, record.dispatch_id, "usage-manifest.json");
    writeFileSync(
      manifestPath,
      `${JSON.stringify({
        schema: "devpro-session-usage-manifest/v1",
        dispatch_id: record.dispatch_id,
        sessions: [],
      })}\n`,
      "utf8",
    );
    const manifestTempPath = path.join(
      rootDir,
      record.dispatch_id,
      ".usage-manifest.1234.12345678-1234-4234-8234-123456789abc.tmp",
    );
    writeFileSync(manifestTempPath, "partial manifest write\n", "utf8");
    const ownerNow = Date.now() + 3 * 60 * 60_000;
    const before = await helper.cleanupOwnedControlEvidence({
      rootDir,
      activeMarkers: [],
      now: Date.now(),
    });
    assert.equal(
      before.results.find((row) => row.dispatchId === record.dispatch_id)?.reason,
      "owner-ttl",
      "fresh complete chain must wait for owner TTL",
    );
    assert.equal(existsSync(path.join(rootDir, record.dispatch_id)), true);

    const after = await helper.cleanupOwnedControlEvidence({
      rootDir,
      activeMarkers: [],
      now: ownerNow,
    });
    assert.equal(after.cleanedDirectories, 1);
    assert.equal(
      existsSync(path.join(rootDir, record.dispatch_id)),
      false,
      "manifest and its abandoned atomic-write temp must not keep a mature complete chain forever",
    );
  });
});

test("Retention cleanup enforces age and count bounds under the capacity lock", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const ownerNow = Date.now();
    const retentionDirectory = path.join(rootDir, ".usage-manifest-retention");
    mkdirSync(retentionDirectory, { recursive: true, mode: 0o700 });
    const abandonedTempPath = path.join(
      retentionDirectory,
      ".usage-manifest.1234.12345678-1234-4234-8234-123456789abc.tmp",
    );
    writeFileSync(abandonedTempPath, "partial retained manifest write\n", "utf8");
    const expiredId = "dispatch-retained-expired";
    const expiredPath = path.join(retentionDirectory, `${expiredId}.json`);
    const expiredAt = new Date(ownerNow - 31 * 24 * 60 * 60_000);
    writeFileSync(expiredPath, `${JSON.stringify({
      schema: "devpro-session-usage-manifest/v1",
      dispatch_id: expiredId,
      attempt_id: "attempt-retained-expired",
      repository_slug: "devpro/example",
      head_ref_oid: "abc123",
      mode: "audit-only",
      review_target: "design",
      recorded_at: expiredAt.toISOString(),
      sessions: [],
      gaps: [],
    })}\n`, { encoding: "utf8", mode: 0o600 });
    utimesSync(expiredPath, expiredAt, expiredAt);

    const recentIds = [];
    for (let index = 0; index < 513; index += 1) {
      const dispatchId = `dispatch-retained-${String(index).padStart(3, "0")}`;
      recentIds.push(dispatchId);
      const recentAt = new Date(ownerNow - 24 * 60 * 60_000 + index * 1000);
      const filePath = path.join(retentionDirectory, `${dispatchId}.json`);
      writeFileSync(filePath, `${JSON.stringify({
        schema: "devpro-session-usage-manifest/v1",
        dispatch_id: dispatchId,
        attempt_id: `attempt-retained-${index}`,
        repository_slug: "devpro/example",
        head_ref_oid: "abc123",
        mode: "audit-only",
        review_target: "design",
        recorded_at: recentAt.toISOString(),
        sessions: [],
        gaps: [],
      })}\n`, { encoding: "utf8", mode: 0o600 });
      utimesSync(filePath, recentAt, recentAt);
    }

    const visibleRecord = dispatchRecord({ dispatch_id: "dispatch-visible-cleanup-preserved" });
    await helper.reserveDispatchRecord({ rootDir, record: visibleRecord });
    const visibleBefore = readdirSync(rootDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
    assert.deepEqual(visibleBefore, [visibleRecord.dispatch_id], "fixture must have one visible dispatch");

    await helper.cleanupOwnedControlEvidence({ rootDir, activeMarkers: [], now: ownerNow });

    const retainedIds = readdirSync(retentionDirectory)
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => entry.slice(0, -5))
      .sort();
    const expectedRetainedIds = recentIds.slice(1).sort();
    assert.equal(
      retainedIds.length,
      512,
      "cleanup must expire the >30-day manifest and enforce the independent 512-copy retention cap",
    );
    assert.equal(
      existsSync(abandonedTempPath),
      false,
      "cleanup must remove abandoned atomic-write temps under the capacity lock",
    );
    assert.deepEqual(
      retainedIds,
      expectedRetainedIds,
      "cleanup must expire the >30-day manifest and evict only the oldest recent manifest to enforce the 512-copy cap",
    );
    const visibleAfter = readdirSync(rootDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
    assert.deepEqual(visibleAfter, visibleBefore, "retention cleanup must preserve visible dispatch eligibility/count");
    assert.equal(
      helper.readDispatchEvidence({ rootDir, dispatchId: visibleRecord.dispatch_id }).dispatch.dispatch_id,
      visibleRecord.dispatch_id,
    );
  });
});

test("marker-free aged orphan reservations are reclaimable; unconsumed faults are not", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const orphan = dispatchRecord({ dispatch_id: "dispatch-orphan-unclaimed" });
    const claimed = dispatchRecord({
      dispatch_id: "dispatch-orphan-claimed",
      attempt_id: "second-review-pr-1658-abc123-claimed",
    });
    const fault = dispatchRecord({
      dispatch_id: "dispatch-orphan-fault",
      attempt_id: "second-review-pr-1658-abc123-fault",
    });
    await helper.reserveDispatchRecord({ rootDir, record: orphan });
    await helper.reserveDispatchRecord({ rootDir, record: claimed });
    await helper.claimDispatchInvocation({ rootDir, record: claimed });
    await helper.reserveDispatchRecord({ rootDir, record: fault });
    await helper.claimDispatchInvocation({ rootDir, record: fault });
    await helper.writeFaultCapsule({
      rootDir,
      record: {
        ...fault,
        schema: "devpro-second-review-fault-capsule/v1",
        classification: "reviewer_orchestration_unknown",
        evidence_provenance: "provider_candidate_unmatched",
        evidence_confidence: "indeterminate",
        matcher_id: "none",
        denied_action_class: "unknown",
        redacted_excerpt: "bounded candidate",
      },
    });

    const ownerNow = Date.now() + 3 * 60 * 60_000;
    const run = await helper.cleanupOwnedControlEvidence({
      rootDir,
      activeMarkers: [],
      now: ownerNow,
    });
    assert.equal(existsSync(path.join(rootDir, orphan.dispatch_id)), false);
    assert.equal(existsSync(path.join(rootDir, claimed.dispatch_id)), false);
    assert.equal(
      existsSync(path.join(rootDir, fault.dispatch_id)),
      true,
      "unconsumed fault must never be time-deleted",
    );
    assert.equal(
      run.results.find((row) => row.dispatchId === fault.dispatch_id)?.reason,
      "unconsumed",
    );
  });
});

test("cleanupOwnedControlEvidence respects budgetMs without throwing", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    for (let index = 0; index < 40; index += 1) {
      await helper.reserveDispatchRecord({
        rootDir,
        record: dispatchRecord({
          pr_number: String(2000 + index),
          attempt_id: `second-review-pr-budget-${index}`,
          dispatch_id: `dispatch-budget-${index}`,
          head_ref_oid: CANONICAL_HEAD_SHA,
        }),
      });
    }
    const run = await helper.cleanupOwnedControlEvidence({
      rootDir,
      activeMarkers: [],
      now: Date.now() + 3 * 60 * 60_000,
      budgetMs: 0,
    });
    assert.equal(run.budgetExhausted, true);
    assert.equal(
      run.results.some((row) => row.reason === "budget-exhausted"),
      true,
    );
  });
});

test("budgeted cleanup still reclaims inspected orphans and advances across calls", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const ownerNow = Date.now() + 3 * 60 * 60_000;
    for (let index = 0; index < 30; index += 1) {
      await helper.reserveDispatchRecord({
        rootDir,
        record: dispatchRecord({
          pr_number: String(4000 + index),
          attempt_id: `second-review-pr-progress-${index}`,
          dispatch_id: `dispatch-progress-${String(index).padStart(2, "0")}`,
          head_ref_oid: CANONICAL_HEAD_SHA,
        }),
      });
    }
    const first = await helper.cleanupOwnedControlEvidence({
      rootDir,
      activeMarkers: [],
      now: ownerNow,
      budgetMs: 5,
    });
    assert.ok(first.inspected > 0, "positive admission must complete its bounded graph");
    const planFile = path.join(rootDir, ".cleanup-retirement.json");
    assert.ok(first.cleanedDirectories > 0 || existsSync(planFile), "first admission must delete or durably retire evidence");
    // A plan is immutable only while it is the live authority. The call that finishes a plan may
    // admit the next one in the same invocation (fast fsync leaves budget), so a changed plan is
    // legal only when the previous plan completed: its members are gone and the call cleaned them.
    let livePlan = existsSync(planFile) ? readFileSync(planFile) : null;
    let removed = first.cleanedDirectories;
    for (let round = 0; round < 100 && removed === 0; round += 1) {
      const next = await helper.cleanupOwnedControlEvidence({ rootDir, activeMarkers: [], now: ownerNow, budgetMs: 5 });
      removed += next.cleanedDirectories;
      const currentPlan = existsSync(planFile) ? readFileSync(planFile) : null;
      if (livePlan && currentPlan && !currentPlan.equals(livePlan)) {
        assert.ok(next.cleanedDirectories > 0,
          "a plan may be replaced only by a call that reported cleaning the previous plan's members");
        for (const member of JSON.parse(livePlan.toString("utf8")).members) {
          assert.equal(existsSync(path.join(rootDir, member.dispatch_id)), false,
            "a replaced plan must have had every member directory removed first");
        }
      } else if (livePlan && currentPlan) {
        assert.deepEqual(currentPlan, livePlan, "recovery must retain immutable plan bytes while the plan is live");
      }
      livePlan = currentPlan;
    }
    assert.ok(removed > 0, "repeated positive invocations resume committed inventory without a new admission budget");
    assert.ok(readdirSync(rootDir).filter((name) => name.startsWith("dispatch-")).length < 30);

  });
});

test("budgeted cleanup advances past retained prefix so eligible orphans are not starved", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const ownerNow = Date.now() + 3 * 60 * 60_000;
    const faultRecords = [];
    const orphanRecords = [];
    for (const index of [0, 1, 2, 3]) {
      const isFault = index % 2 === 0;
      const record = dispatchRecord({
        pr_number: String(5000 + index),
        attempt_id: `second-review-pr-starve-${index}${isFault ? "-fault" : "-orphan"}`,
        dispatch_id: `dispatch-starve-${index}-${isFault ? "fault" : "orphan"}`,
        head_ref_oid: CANONICAL_HEAD_SHA,
      });
      await helper.reserveDispatchRecord({ rootDir, record });
      if (isFault) {
        await helper.claimDispatchInvocation({ rootDir, record });
        await helper.writeFaultCapsule({
          rootDir,
          record: {
            ...record,
            schema: "devpro-second-review-fault-capsule/v1",
            classification: "reviewer_orchestration_unknown",
            evidence_provenance: "provider_candidate_unmatched",
            evidence_confidence: "indeterminate",
            matcher_id: "none",
            denied_action_class: "unknown",
            redacted_excerpt: "retained prefix for starvation proof",
          },
        });
        faultRecords.push(record);
      } else {
        orphanRecords.push(record);
      }
    }

    // Deterministic clamps: inspect 2, cleanup 1. Retained faults at even
    // indices would starve odd orphans if the cursor advanced by inspected.length.
    for (let round = 0; round < 4; round += 1) {
      await helper.cleanupOwnedControlEvidence({
        rootDir,
        activeMarkers: [],
        now: ownerNow,
        maxInspect: 2,
        maxCleanup: 1,
      });
    }

    for (const orphan of orphanRecords) {
      assert.equal(
        existsSync(path.join(rootDir, orphan.dispatch_id)),
        false,
        `${orphan.dispatch_id} must eventually reclaim despite retained fault prefix`,
      );
    }
    for (const fault of faultRecords) {
      assert.equal(
        existsSync(path.join(rootDir, fault.dispatch_id)),
        true,
        `${fault.dispatch_id} unconsumed fault must remain`,
      );
    }
  });
});

test("controlEvidenceRoot requires isolation override when suite guard is set", async () => {
  const helper = await loadHelper();
  assert.throws(
    () => helper.controlEvidenceRoot({ DEVPRO_REQUIRE_ISOLATED_CONTROL_EVIDENCE: "1" }, process.cwd()),
    /DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR is required/,
  );
  const isolated = helper.controlEvidenceRoot(
    {
      DEVPRO_REQUIRE_ISOLATED_CONTROL_EVIDENCE: "1",
      DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: "/tmp/devpro-isolated-control-evidence",
    },
    process.cwd(),
  );
  assert.equal(isolated, path.resolve("/tmp/devpro-isolated-control-evidence"));
});

// ---------------------------------------------------------------------------
// T2 (R4, R5, R13): external-evaluator closure slot, fourth completion form,
// void terminal, strict/raw layering, predecessor carve-out.
// design.md D4 steps 5-9, D5. tasks.md T2.
// ---------------------------------------------------------------------------

test("assertSecondReviewDispatchRecord accepts external fields additively and keeps runner bytes unchanged", async () => {
  const helper = await loadHelper();
  const runnerRecord = dispatchRecord();
  assert.equal(helper.assertSecondReviewDispatchRecord(runnerRecord), runnerRecord);
  assert.equal(Object.hasOwn(runnerRecord, "executor_kind"), false);

  const external = externalDispatchRecord();
  assert.equal(helper.assertSecondReviewDispatchRecord(external), external);

  // Missing any required external field -> exact-field-set collision.
  for (const field of [
    "executor_kind",
    "reviewer_family",
    "primary_family",
    "reviewer_tool",
    "sticky_write_action",
    "sticky_target_comment_id",
    "sticky_snapshot_digest",
    "issued_at",
  ]) {
    const { [field]: _omit, ...withoutField } = external;
    assert.throws(
      () => helper.assertSecondReviewDispatchRecord(withoutField),
      /exact canonical field set/,
      `missing ${field} must be rejected`
    );
  }

  assert.throws(
    () => helper.assertSecondReviewDispatchRecord({ ...external, executor_kind: "runner" }),
    /executor_kind is invalid/
  );
  assert.throws(
    () => helper.assertSecondReviewDispatchRecord({ ...external, sticky_write_action: "delete" }),
    /sticky_write_action is invalid/
  );
  assert.throws(
    () => helper.assertSecondReviewDispatchRecord({ ...external, sticky_target_comment_id: 42 }),
    /sticky_target_comment_id must be null for a create disposition/
  );
  assert.throws(
    () => helper.assertSecondReviewDispatchRecord({
      ...external,
      sticky_write_action: "update",
      sticky_target_comment_id: null,
    }),
    /sticky_target_comment_id must be a positive integer for an update disposition/
  );
  assert.throws(
    () => helper.assertSecondReviewDispatchRecord({
      ...external,
      sticky_write_action: "update",
      sticky_target_comment_id: -1,
    }),
    /sticky_target_comment_id must be a positive integer for an update disposition/
  );
  assert.equal(
    helper.assertSecondReviewDispatchRecord({
      ...external,
      dispatch_id: "dispatch-external-update",
      sticky_write_action: "update",
      sticky_target_comment_id: 99,
    }).sticky_target_comment_id,
    99
  );
  assert.throws(
    () => helper.assertSecondReviewDispatchRecord({ ...external, sticky_snapshot_digest: "not-a-digest" }),
    /sticky_snapshot_digest is invalid/
  );
  assert.throws(
    () => helper.assertSecondReviewDispatchRecord({ ...external, issued_at: "2026-08-20T00:00:00Z" }),
    /issued_at is invalid/
  );

  // D1: external dispatches never page — combining external + v5 paged
  // binding must fail closed rather than silently unioning both field sets.
  assert.throws(
    () => helper.assertSecondReviewDispatchRecord({
      ...external,
      paged_full_material_sha256: "c".repeat(64),
      paged_full_material_created_at: "2026-08-13T00:00:00.000Z",
      paged_full_material_expires_at: "2026-08-13T02:00:00.000Z",
    }),
    /external dispatch record must not carry paged full-material binding/
  );
});

test("secondReviewDispatchRecord only assigns external keys on the external branch and stays byte-exact", async () => {
  const helper = await loadHelper();
  const packetBytes = Buffer.from("packet", "utf8");
  const runnerContext = {
    repository_slug: "devpro/example",
    pr_number: "1658",
    head_ref_oid: "abc123",
    attempt_id: "second-review-pr-1658-abc123-initial",
    dispatch_id: "dispatch-1658-current",
    previous_dispatch_id: null,
    observability_context_path: "/repo/notes/cross-review/second-review-pr-1658/observability-context.json",
  };
  const runnerRecord = helper.secondReviewDispatchRecord({ context: runnerContext, packetBytes });
  assert.deepEqual(Object.keys(runnerRecord).sort(), [
    "attempt_id",
    "carrier_root_id",
    "dispatch_id",
    "head_ref_oid",
    "packet_sha256",
    "pr_number",
    "previous_dispatch_id",
    "repository_slug",
    "schema",
  ]);

  const externalContext = {
    ...runnerContext,
    dispatch_id: "dispatch-1658-external",
    executor_kind: "external-evaluator",
    reviewer_family: "gemini",
    primary_family: "claude",
    reviewer_tool: "Gemini CLI",
    sticky_write_action: "create",
    sticky_target_comment_id: null,
    sticky_snapshot_digest: "d".repeat(64),
    issued_at: "2026-08-20T00:00:00.000Z",
  };
  const externalRecord = helper.secondReviewDispatchRecord({ context: externalContext, packetBytes });
  assert.equal(helper.assertSecondReviewDispatchRecord(externalRecord), externalRecord);
  assert.equal(externalRecord.executor_kind, "external-evaluator");
  assert.equal(externalRecord.reviewer_tool, "Gemini CLI");
  assert.equal(externalRecord.sticky_target_comment_id, null);
  // Exact insertion order matters for canonical bytes — T3/T5 reconstruct and
  // compare these records byte-for-byte.
  assert.deepEqual(Object.keys(externalRecord), [
    "schema",
    "repository_slug",
    "pr_number",
    "head_ref_oid",
    "attempt_id",
    "dispatch_id",
    "previous_dispatch_id",
    "packet_sha256",
    "carrier_root_id",
    "executor_kind",
    "reviewer_family",
    "primary_family",
    "reviewer_tool",
    "sticky_write_action",
    "sticky_target_comment_id",
    "sticky_snapshot_digest",
    "issued_at",
  ]);
});

test("writeExternalClosureSlot exclusively publishes accepted and voided slots with exact stable-field reconciliation", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const dispatch = externalDispatchRecord();
    await helper.reserveDispatchRecord({ rootDir, record: dispatch });
    const payload = externalReceiptPayload(dispatch);

    // Non-external dispatch must be rejected.
    const runner = dispatchRecord({ dispatch_id: "dispatch-runner-for-slot" });
    await helper.reserveDispatchRecord({ rootDir, record: runner });
    await assert.rejects(
      () => helper.writeExternalClosureSlot({ rootDir, dispatchId: runner.dispatch_id, kind: "accepted", receiptPayload: payload }),
      /requires an external dispatch reservation/
    );

    // Malformed payload shape must be rejected before any slot is created.
    await assert.rejects(
      () => helper.writeExternalClosureSlot({
        rootDir,
        dispatchId: dispatch.dispatch_id,
        kind: "accepted",
        receiptPayload: { ...payload, sticky_verdict: "MAYBE" },
      }),
    );
    assert.equal(existsSync(path.join(rootDir, dispatch.dispatch_id, "external-closure.json")), false);

    const created = await helper.writeExternalClosureSlot({
      rootDir,
      dispatchId: dispatch.dispatch_id,
      kind: "accepted",
      receiptPayload: payload,
    });
    assert.equal(created.status, "created");
    assert.equal(created.record.kind, "accepted");
    assert.deepEqual(created.record.receipt_payload, payload);
    assert.equal(created.record.schema, "devpro-second-review-external-closure/v1");
    const firstClosedAt = created.record.closed_at;
    const slotPath = path.join(rootDir, dispatch.dispatch_id, "external-closure.json");
    const slotBytesBeforeRerun = readFileSync(slotPath);

    // Same-kind rerun on a different clock must adopt the already-published
    // closed_at and produce byte-identical slot content.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const rerun = await helper.writeExternalClosureSlot({
      rootDir,
      dispatchId: dispatch.dispatch_id,
      kind: "accepted",
      receiptPayload: payload,
    });
    assert.equal(rerun.status, "idempotent");
    assert.equal(rerun.record.closed_at, firstClosedAt);
    assert.deepEqual(readFileSync(slotPath), slotBytesBeforeRerun);

    // Opposite-kind attempt must fail closed as external_dispatch_closed, not
    // silently overwrite (and must never use renameSync semantics).
    await assert.rejects(
      () => helper.writeExternalClosureSlot({ rootDir, dispatchId: dispatch.dispatch_id, kind: "voided" }),
      (error) => error.classification === "external_dispatch_closed"
    );

    // A second, disagreeing accepted payload for the same dispatch must
    // collide rather than silently winning.
    await assert.rejects(
      () => helper.writeExternalClosureSlot({
        rootDir,
        dispatchId: dispatch.dispatch_id,
        kind: "accepted",
        receiptPayload: { ...payload, sticky_verdict: "WARN" },
      }),
      /collision/
    );

    // A fresh voided dispatch persists a payload-free slot.
    const voidDispatch = externalDispatchRecord({ dispatch_id: "dispatch-external-void" });
    await helper.reserveDispatchRecord({ rootDir, record: voidDispatch });
    const voided = await helper.writeExternalClosureSlot({
      rootDir,
      dispatchId: voidDispatch.dispatch_id,
      kind: "voided",
    });
    assert.equal(voided.status, "created");
    assert.equal(voided.record.kind, "voided");
    assert.equal(Object.hasOwn(voided.record, "receipt_payload"), false);
  });
});

test("assertExternalSlotOwnership is a raw check that does not require completion/terminal evidence to exist yet", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const dispatch = externalDispatchRecord({ dispatch_id: "dispatch-external-ownership" });
    await helper.reserveDispatchRecord({ rootDir, record: dispatch });
    const payload = externalReceiptPayload(dispatch);
    await helper.writeExternalClosureSlot({ rootDir, dispatchId: dispatch.dispatch_id, kind: "accepted", receiptPayload: payload });
    const directory = path.join(rootDir, dispatch.dispatch_id);

    // A "just-placed, not-yet-written-receipt" writer is not blocked by
    // strictness — the whole point of assertExternalSlotOwnership (D4 step 6).
    const owned = helper.assertExternalSlotOwnership(directory, "accepted", {
      dispatch_id: dispatch.dispatch_id,
      receipt_payload: payload,
    });
    assert.deepEqual(owned.receipt_payload, payload);

    // Ownership without a receipt_payload key only checks presence/kind.
    assert.equal(
      helper.assertExternalSlotOwnership(directory, "accepted", { dispatch_id: dispatch.dispatch_id }).kind,
      "accepted"
    );

    assert.throws(
      () => helper.assertExternalSlotOwnership(directory, "voided", { dispatch_id: dispatch.dispatch_id }),
      (error) => error.classification === "external_dispatch_closed"
    );
    assert.throws(
      () => helper.assertExternalSlotOwnership(directory, "accepted", {
        dispatch_id: dispatch.dispatch_id,
        receipt_payload: { ...payload, sticky_verdict: "WARN" },
      }),
      /does not match the expected accepted disposition content/
    );

    const missingDirectory = path.join(rootDir, "dispatch-external-never-closed");
    mkdirSync(missingDirectory, { recursive: true });
    assert.throws(
      () => helper.assertExternalSlotOwnership(missingDirectory, "accepted", { dispatch_id: "dispatch-external-never-closed" }),
      /ownership could not be verified/
    );
  });
});

test("writeExternalCompletionReceipt closes all four verdicts from the slot alone, without any live re-read", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    for (const verdict of ["PASS", "WARN", "CRITICAL", "UNAVAILABLE"]) {
      const dispatch = externalDispatchRecord({ dispatch_id: `dispatch-external-verdict-${verdict.toLowerCase()}` });
      await helper.reserveDispatchRecord({ rootDir, record: dispatch });
      const payload = externalReceiptPayload(dispatch, { sticky_verdict: verdict });
      await helper.writeExternalClosureSlot({ rootDir, dispatchId: dispatch.dispatch_id, kind: "accepted", receiptPayload: payload });

      const first = await helper.writeExternalCompletionReceipt({ rootDir, dispatchId: dispatch.dispatch_id });
      assert.equal(first.status, "created");
      assert.equal(first.record.outcome, "external_evaluator_sticky_accepted");
      assert.equal(first.record.classification, "external_evaluator_accepted");
      assert.equal(first.record.sticky_verdict, verdict);
      assert.equal(first.record.process_close_observed, false);
      assert.equal(first.record.sticky_body_sha256, payload.sticky_body_sha256);
      assert.deepEqual(Object.keys(first.record).sort(), [
        "attempt_id",
        "classification",
        "dispatch_id",
        "head_ref_oid",
        "integrity_id",
        "outcome",
        "previous_dispatch_id",
        "pr_number",
        "process_close_observed",
        "repository_slug",
        "schema",
        "sticky_comment_id",
        "sticky_comment_url",
        "sticky_dispatch_id",
        "sticky_last_reviewed_sha",
        "sticky_verdict",
        "sticky_body_sha256",
      ].sort());

      // Crash-resume: calling again with only a dispatch_id (no live data of
      // any kind available to the function) must reconstruct byte-identical
      // evidence purely from the durable slot.
      const rerunBytes = readFileSync(path.join(rootDir, dispatch.dispatch_id, "completion-receipt.json"));
      const second = await helper.writeExternalCompletionReceipt({ rootDir, dispatchId: dispatch.dispatch_id });
      assert.equal(second.status, "idempotent");
      assert.deepEqual(readFileSync(path.join(rootDir, dispatch.dispatch_id, "completion-receipt.json")), rerunBytes);
    }
  });
});

test("runner completion receipt behavior is unaffected: still requires a claim and rejects CRITICAL/UNAVAILABLE", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const record = dispatchRecord({ dispatch_id: "dispatch-runner-completion-regression" });
    await helper.reserveDispatchRecord({ rootDir, record });
    await assert.rejects(
      () => helper.writeCompletionReceipt({
        rootDir,
        record: {
          ...record,
          schema: helper.COMPLETION_SCHEMA,
          outcome: "reviewer_process_closed_and_sticky_verified",
          classification: "sticky_verified",
          sticky_verdict: "PASS",
          sticky_last_reviewed_sha: record.head_ref_oid,
          sticky_dispatch_id: record.dispatch_id,
          sticky_comment_id: 1,
          sticky_comment_url: `https://github.com/${record.repository_slug}/pull/${record.pr_number}#issuecomment-1`,
          process_close_observed: true,
        },
      }),
      /requires a claimed dispatch/
    );
    await helper.claimDispatchInvocation({ rootDir, record });
    await assert.rejects(
      () => helper.writeCompletionReceipt({
        rootDir,
        record: {
          ...record,
          schema: helper.COMPLETION_SCHEMA,
          outcome: "reviewer_process_closed_and_sticky_verified",
          classification: "sticky_verified",
          sticky_verdict: "CRITICAL",
          sticky_last_reviewed_sha: record.head_ref_oid,
          sticky_dispatch_id: record.dispatch_id,
          sticky_comment_id: 1,
          sticky_comment_url: `https://github.com/${record.repository_slug}/pull/${record.pr_number}#issuecomment-1`,
          process_close_observed: true,
        },
      }),
      /terminal outcome or sticky binding is invalid/
    );
  });
});

test("writeExternalVoidTerminalReceipt uses the slot's closed_at, is idempotent under real concurrency, and detects byte drift", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const dispatch = externalDispatchRecord({ dispatch_id: "dispatch-external-void-terminal" });
    await helper.reserveDispatchRecord({ rootDir, record: dispatch });
    const slot = await helper.writeExternalClosureSlot({ rootDir, dispatchId: dispatch.dispatch_id, kind: "voided" });

    const results = await Promise.all(
      Array.from({ length: 4 }, () => helper.writeExternalVoidTerminalReceipt({ rootDir, dispatchId: dispatch.dispatch_id }))
    );
    assert.equal(results.filter((result) => result.status === "created").length, 1);
    assert.equal(results.filter((result) => result.status === "idempotent").length, 3);
    for (const result of results) {
      assert.equal(result.record.created_at, slot.record.closed_at);
      assert.equal(result.record.outcome_group, "external_evaluator_closed");
      assert.equal(result.record.classification, "external_evaluator_voided");
      assert.equal(result.record.lifecycle_phase, "pre_spawn_known_terminal");
      assert.equal(result.record.process_spawned, false);
      assert.equal(result.record.process_close_observed, false);
      assert.equal(result.record.transport_cleanup_confirmed, true);
      assert.equal(result.record.invocation_claim_sha256, null);
    }
    assert.equal(
      readdirSync(path.join(rootDir, dispatch.dispatch_id)).filter((name) => name === "terminal-receipt.json").length,
      1
    );

    const tamperedDispatch = externalDispatchRecord({ dispatch_id: "dispatch-external-void-tampered" });
    await helper.reserveDispatchRecord({ rootDir, record: tamperedDispatch });
    await helper.writeExternalClosureSlot({ rootDir, dispatchId: tamperedDispatch.dispatch_id, kind: "voided" });
    writeFileSync(
      path.join(rootDir, tamperedDispatch.dispatch_id, "terminal-receipt.json"),
      `${JSON.stringify({ not: "the canonical receipt" })}\n`
    );
    await assert.rejects(
      () => helper.writeExternalVoidTerminalReceipt({ rootDir, dispatchId: tamperedDispatch.dispatch_id }),
    );
  });
});

test("readDispatchEvidenceStrict fails closed on every incomplete external closure state; raw reads and raw writers are unaffected", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();

    const accepted = externalDispatchRecord({ dispatch_id: "dispatch-external-strict-accepted-pending" });
    await helper.reserveDispatchRecord({ rootDir, record: accepted });
    await helper.writeExternalClosureSlot({
      rootDir,
      dispatchId: accepted.dispatch_id,
      kind: "accepted",
      receiptPayload: externalReceiptPayload(accepted),
    });
    assert.throws(
      () => helper.readDispatchEvidenceStrict({ rootDir, dispatchId: accepted.dispatch_id }),
      (error) => error.classification === "external_closure_incomplete"
    );
    // Raw read must not be blocked by the same incompleteness.
    const raw = helper.readDispatchEvidence({ rootDir, dispatchId: accepted.dispatch_id });
    assert.equal(raw.dispatch.dispatch_id, accepted.dispatch_id);
    assert.equal(raw.completion, null);
    // The raw writer completes normally despite strict-mode incompleteness.
    const completed = await helper.writeExternalCompletionReceipt({ rootDir, dispatchId: accepted.dispatch_id });
    assert.equal(completed.status, "created");
    assert.equal(
      helper.readDispatchEvidenceStrict({ rootDir, dispatchId: accepted.dispatch_id }).completion.dispatch_id,
      accepted.dispatch_id
    );

    const voided = externalDispatchRecord({ dispatch_id: "dispatch-external-strict-voided-pending" });
    await helper.reserveDispatchRecord({ rootDir, record: voided });
    await helper.writeExternalClosureSlot({ rootDir, dispatchId: voided.dispatch_id, kind: "voided" });
    assert.throws(
      () => helper.readDispatchEvidenceStrict({ rootDir, dispatchId: voided.dispatch_id }),
      (error) => error.classification === "external_closure_incomplete"
    );
    assert.equal(helper.readDispatchEvidence({ rootDir, dispatchId: voided.dispatch_id }).terminal, null);

    const unresolved = externalDispatchRecord({ dispatch_id: "dispatch-external-strict-no-slot" });
    await helper.reserveDispatchRecord({ rootDir, record: unresolved });
    assert.throws(
      () => helper.readDispatchEvidenceStrict({ rootDir, dispatchId: unresolved.dispatch_id }),
      (error) => error.classification === "external_closure_incomplete"
    );
    assert.equal(helper.readDispatchEvidence({ rootDir, dispatchId: unresolved.dispatch_id }).dispatch.dispatch_id, unresolved.dispatch_id);

    // Corrupt slot: strict fails closed; raw read of the bare dispatch (no
    // completion/terminal yet) is unaffected, so a corrupt slot elsewhere in
    // the repository cannot block capacity scans or new reservations.
    const corrupt = externalDispatchRecord({ dispatch_id: "dispatch-external-strict-corrupt-slot" });
    await helper.reserveDispatchRecord({ rootDir, record: corrupt });
    writeFileSync(path.join(rootDir, corrupt.dispatch_id, "external-closure.json"), "{not json");
    assert.throws(
      () => helper.readDispatchEvidenceStrict({ rootDir, dispatchId: corrupt.dispatch_id }),
      (error) => error.classification === "external_closure_incomplete"
    );
    assert.equal(helper.readDispatchEvidence({ rootDir, dispatchId: corrupt.dispatch_id }).dispatch.dispatch_id, corrupt.dispatch_id);

    // Runner (non-external) dispatch: readDispatchEvidenceStrict must return
    // exactly what readDispatchEvidence returns, with no slot semantics at all.
    const runner = dispatchRecord({ dispatch_id: "dispatch-runner-strict-passthrough" });
    await helper.reserveDispatchRecord({ rootDir, record: runner });
    assert.deepEqual(
      helper.readDispatchEvidenceStrict({ rootDir, dispatchId: runner.dispatch_id }),
      helper.readDispatchEvidence({ rootDir, dispatchId: runner.dispatch_id })
    );
  });
});

function withRecomputedIntegrity(record) {
  const { integrity_id: _ignored, ...identity } = record;
  return {
    ...identity,
    integrity_id: createHash("sha256").update(JSON.stringify(identity), "utf8").digest("hex"),
  };
}

// Primary-review F-11: presence of a schema/integrity-valid receipt is not
// sufficient — readDispatchEvidenceStrict must also verify its bytes equal
// what the same builder the writer uses would rebuild from the slot's own
// stored content (receipt_payload for accepted, the slot itself for voided).
test("readDispatchEvidenceStrict fails closed on a tampered-but-self-consistent completion receipt", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const dispatch = externalDispatchRecord({ dispatch_id: "dispatch-external-strict-receipt-mismatch" });
    await helper.reserveDispatchRecord({ rootDir, record: dispatch });
    await helper.writeExternalClosureSlot({
      rootDir,
      dispatchId: dispatch.dispatch_id,
      kind: "accepted",
      receiptPayload: externalReceiptPayload(dispatch),
    });
    await helper.writeExternalCompletionReceipt({ rootDir, dispatchId: dispatch.dispatch_id });

    // Sanity: before tampering, the strict reader succeeds.
    assert.equal(
      helper.readDispatchEvidenceStrict({ rootDir, dispatchId: dispatch.dispatch_id }).completion.sticky_verdict,
      "PASS"
    );

    const receiptPath = path.join(rootDir, dispatch.dispatch_id, "completion-receipt.json");
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    receipt.sticky_verdict = "WARN";
    writeFileSync(receiptPath, `${JSON.stringify(withRecomputedIntegrity(receipt))}\n`);

    assert.throws(
      () => helper.readDispatchEvidenceStrict({ rootDir, dispatchId: dispatch.dispatch_id }),
      (error) => error.classification === "external_closure_receipt_mismatch"
    );
    // Raw read must not be blocked by the same content mismatch — only the
    // strict reader compares against the rebuilt receipt.
    const raw = helper.readDispatchEvidence({ rootDir, dispatchId: dispatch.dispatch_id });
    assert.equal(raw.completion.sticky_verdict, "WARN");
  });
});

test("readDispatchEvidenceStrict fails closed on a tampered-but-self-consistent void terminal receipt", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const dispatch = externalDispatchRecord({ dispatch_id: "dispatch-external-strict-terminal-mismatch" });
    await helper.reserveDispatchRecord({ rootDir, record: dispatch });
    await helper.writeExternalClosureSlot({ rootDir, dispatchId: dispatch.dispatch_id, kind: "voided" });
    await helper.writeExternalVoidTerminalReceipt({ rootDir, dispatchId: dispatch.dispatch_id });

    assert.equal(
      helper.readDispatchEvidenceStrict({ rootDir, dispatchId: dispatch.dispatch_id }).terminal.dispatch_id,
      dispatch.dispatch_id
    );

    const terminalPath = path.join(rootDir, dispatch.dispatch_id, "terminal-receipt.json");
    const terminal = JSON.parse(readFileSync(terminalPath, "utf8"));
    // created_at is still a canonical ISO timestamp (assertTerminalReceipt
    // does not compare it to the slot's closed_at), so this is valid-but-drifted.
    terminal.created_at = new Date(Date.parse(terminal.created_at) + 60_000).toISOString();
    writeFileSync(terminalPath, `${JSON.stringify(withRecomputedIntegrity(terminal))}\n`);

    assert.throws(
      () => helper.readDispatchEvidenceStrict({ rootDir, dispatchId: dispatch.dispatch_id }),
      (error) => error.classification === "external_closure_receipt_mismatch"
    );
    const raw = helper.readDispatchEvidence({ rootDir, dispatchId: dispatch.dispatch_id });
    assert.notEqual(raw.terminal.created_at, undefined);
  });
});

test("external completion or terminal evidence without its closure slot fails raw reads closed", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const dispatch = externalDispatchRecord({ dispatch_id: "dispatch-external-orphan-receipt" });
    await helper.reserveDispatchRecord({ rootDir, record: dispatch });
    const payload = externalReceiptPayload(dispatch);
    const receipt = withIntegrity({
      schema: "devpro-second-review-completion/v2",
      ...payload,
      outcome: "external_evaluator_sticky_accepted",
      classification: "external_evaluator_accepted",
      process_close_observed: false,
    });
    writeFileSync(path.join(rootDir, dispatch.dispatch_id, "completion-receipt.json"), `${JSON.stringify(receipt)}\n`);
    assert.throws(
      () => helper.readDispatchEvidence({ rootDir, dispatchId: dispatch.dispatch_id }),
      /requires its closure slot to exist/
    );
  });
});

test("predecessor lineage accepts an external completion or external void terminal without an invocation claim; runner keeps its exact message", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();

    const acceptedPredecessor = externalDispatchRecord({ dispatch_id: "dispatch-external-lineage-accepted" });
    await helper.reserveDispatchRecord({ rootDir, record: acceptedPredecessor });
    await helper.writeExternalClosureSlot({
      rootDir,
      dispatchId: acceptedPredecessor.dispatch_id,
      kind: "accepted",
      receiptPayload: externalReceiptPayload(acceptedPredecessor),
    });
    await helper.writeExternalCompletionReceipt({ rootDir, dispatchId: acceptedPredecessor.dispatch_id });

    // Cross-head successor: the dogfood "reissue after acceptance" case.
    const successor = dispatchRecord({
      dispatch_id: "dispatch-runner-successor-of-external",
      head_ref_oid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      attempt_id: "second-review-pr-1658-successor",
      previous_dispatch_id: acceptedPredecessor.dispatch_id,
    });
    const reserved = await reserveWithMarkerWitness(helper, rootDir, successor);
    assert.equal(reserved.status, "created");

    const voidedPredecessor = externalDispatchRecord({ dispatch_id: "dispatch-external-lineage-voided" });
    await helper.reserveDispatchRecord({ rootDir, record: voidedPredecessor });
    await helper.writeExternalClosureSlot({ rootDir, dispatchId: voidedPredecessor.dispatch_id, kind: "voided" });
    await helper.writeExternalVoidTerminalReceipt({ rootDir, dispatchId: voidedPredecessor.dispatch_id });
    const reissue = dispatchRecord({
      dispatch_id: "dispatch-runner-reissue-after-void",
      head_ref_oid: "cccccccccccccccccccccccccccccccccccccccc",
      attempt_id: "second-review-pr-1658-reissue",
      previous_dispatch_id: voidedPredecessor.dispatch_id,
    });
    assert.equal((await reserveWithMarkerWitness(helper, rootDir, reissue)).status, "created");

    // Runner predecessor completion without a claim still fails closed with
    // the exact existing message.
    const runnerPredecessor = dispatchRecord({ dispatch_id: "dispatch-runner-lineage-predecessor" });
    mkdirSync(path.join(rootDir, runnerPredecessor.dispatch_id), { recursive: true });
    writeFileSync(
      path.join(rootDir, runnerPredecessor.dispatch_id, "dispatch.json"),
      `${JSON.stringify(runnerPredecessor)}\n`
    );
    writeCanonicalEvidence(rootDir, runnerPredecessor.dispatch_id, "completion-receipt.json", {
      ...dispatchLifecycleIdentity(runnerPredecessor),
      schema: helper.COMPLETION_SCHEMA,
      outcome: "reviewer_process_closed_and_sticky_verified",
      classification: "sticky_verified",
      sticky_verdict: "PASS",
      sticky_last_reviewed_sha: runnerPredecessor.head_ref_oid,
      sticky_dispatch_id: runnerPredecessor.dispatch_id,
      sticky_comment_id: 1,
      sticky_comment_url: `https://github.com/${runnerPredecessor.repository_slug}/pull/${runnerPredecessor.pr_number}#issuecomment-1`,
      process_close_observed: true,
    });
    const orphanSuccessor = dispatchRecord({
      dispatch_id: "dispatch-runner-orphan-successor",
      head_ref_oid: "dddddddddddddddddddddddddddddddddddddddd",
      attempt_id: "second-review-pr-1658-orphan-successor",
      previous_dispatch_id: runnerPredecessor.dispatch_id,
    });
    await assert.rejects(
      () => helper.reserveDispatchRecord({ rootDir, record: orphanSuccessor }),
      /predecessor completion evidence requires an invocation claim/
    );
  });
});

function externalOutcomeCompletionFields(record, overrides = {}) {
  return {
    ...dispatchLifecycleIdentity(record),
    schema: "devpro-second-review-completion/v2",
    outcome: "external_evaluator_sticky_accepted",
    classification: "external_evaluator_accepted",
    sticky_verdict: "PASS",
    sticky_last_reviewed_sha: record.head_ref_oid,
    sticky_dispatch_id: record.dispatch_id,
    sticky_comment_id: 2,
    sticky_comment_url: `https://github.com/${record.repository_slug}/pull/${record.pr_number}#issuecomment-2`,
    sticky_body_sha256: "e".repeat(64),
    process_close_observed: false,
    ...overrides,
  };
}

// Primary review r2, F-aeesr-r2-07: the raw aggregate reader's "completion
// receipt requires an invocation claim" exemption keys ONLY off the
// completion's own outcome/classification — not off whether the dispatch it
// is filed under is itself external. A runner (non-external) dispatch
// directory containing an external-outcome-shaped completion must NOT be
// silently treated as closed.
test("readDispatchEvidence requires the dispatch itself to be external before exempting an external-outcome completion from the invocation-claim requirement", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const runner = dispatchRecord({ dispatch_id: "dispatch-runner-forged-external-completion" });
    await helper.reserveDispatchRecord({ rootDir, record: runner });
    // Hand-plant an external-outcome-shaped completion receipt directly under
    // a RUNNER dispatch directory (no executor_kind on the dispatch record
    // itself, never written by writeExternalCompletionReceipt, which itself
    // requires isExternalDispatchRecord(evidence.dispatch)).
    writeCanonicalEvidence(
      rootDir,
      runner.dispatch_id,
      "completion-receipt.json",
      externalOutcomeCompletionFields(runner)
    );
    assert.throws(
      () => helper.readDispatchEvidence({ rootDir, dispatchId: runner.dispatch_id }),
      (error) => error.classification === "reviewer_dispatch_identity_collision"
        && /completion receipt requires an invocation claim/.test(error.message)
    );
  });
});

// The predecessor reader has the same gap in its own, separate exemption —
// and additionally never reads the closure slot at all for an external
// predecessor, so a hand-authored (never-slotted) completion could lineage-
// chain as if it were TL-accepted.
test("readDirectPredecessorEvidence requires an external predecessor's completion to be backed by an accepted closure slot", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const predecessor = externalDispatchRecord({ dispatch_id: "dispatch-external-predecessor-no-slot" });
    await helper.reserveDispatchRecord({ rootDir, record: predecessor });
    // No writeExternalClosureSlot call at all — hand-plant a completion
    // receipt directly, simulating corrupted/hand-authored evidence with no
    // backing slot (writeExternalCompletionReceipt itself would refuse this:
    // assertExternalSlotOwnership requires a present "accepted" slot first).
    writeCanonicalEvidence(
      rootDir,
      predecessor.dispatch_id,
      "completion-receipt.json",
      externalOutcomeCompletionFields(predecessor)
    );

    const successor = dispatchRecord({
      dispatch_id: "dispatch-runner-successor-no-slot",
      head_ref_oid: "5555555555555555555555555555555555555555",
      attempt_id: "second-review-pr-1658-successor-no-slot",
      previous_dispatch_id: predecessor.dispatch_id,
    });
    await assert.rejects(
      () => helper.reserveDispatchRecord({ rootDir, record: successor }),
      (error) => error.classification === "reviewer_dispatch_identity_collision"
        && /closure slot/.test(error.message)
    );
  });
});

// A predecessor whose closure slot exists but holds the WRONG kind (voided,
// not accepted) for a completion receipt must also be rejected, not just an
// entirely-absent slot.
test("readDirectPredecessorEvidence rejects an external predecessor completion backed by a voided (not accepted) closure slot", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const predecessor = externalDispatchRecord({ dispatch_id: "dispatch-external-predecessor-wrong-slot-kind" });
    await helper.reserveDispatchRecord({ rootDir, record: predecessor });
    await helper.writeExternalClosureSlot({ rootDir, dispatchId: predecessor.dispatch_id, kind: "voided" });
    // Hand-plant a completion receipt even though the slot says voided —
    // writeExternalCompletionReceipt itself would refuse this (assertExternalSlotOwnership
    // requires kind "accepted"), so this simulates corrupted/hand-authored evidence.
    writeCanonicalEvidence(
      rootDir,
      predecessor.dispatch_id,
      "completion-receipt.json",
      externalOutcomeCompletionFields(predecessor)
    );

    const successor = dispatchRecord({
      dispatch_id: "dispatch-runner-successor-wrong-slot-kind",
      head_ref_oid: "6666666666666666666666666666666666666666",
      attempt_id: "second-review-pr-1658-successor-wrong-slot-kind",
      previous_dispatch_id: predecessor.dispatch_id,
    });
    await assert.rejects(
      () => helper.reserveDispatchRecord({ rootDir, record: successor }),
      (error) => error.classification === "reviewer_dispatch_identity_collision"
        && /accepted closure slot/.test(error.message)
    );
  });
});

// Second review r1 finding 1: a slot of the right kind is not enough — the
// predecessor reader must apply the same slot-to-receipt canonical comparison
// as readDispatchEvidenceStrict, so an altered receipt with a recomputed
// integrity_id cannot lineage-chain.
test("readDirectPredecessorEvidence rejects a tampered-but-self-consistent external completion or void terminal receipt", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();

    const accepted = externalDispatchRecord({ dispatch_id: "dispatch-external-predecessor-tampered-completion" });
    await helper.reserveDispatchRecord({ rootDir, record: accepted });
    await helper.writeExternalClosureSlot({
      rootDir,
      dispatchId: accepted.dispatch_id,
      kind: "accepted",
      receiptPayload: externalReceiptPayload(accepted),
    });
    await helper.writeExternalCompletionReceipt({ rootDir, dispatchId: accepted.dispatch_id });
    const receiptPath = path.join(rootDir, accepted.dispatch_id, "completion-receipt.json");
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    receipt.sticky_verdict = "WARN";
    writeFileSync(receiptPath, `${JSON.stringify(withRecomputedIntegrity(receipt))}\n`);
    await assert.rejects(
      () => helper.reserveDispatchRecord({
        rootDir,
        record: dispatchRecord({
          dispatch_id: "dispatch-runner-successor-tampered-completion",
          head_ref_oid: "7777777777777777777777777777777777777777",
          attempt_id: "second-review-pr-1658-successor-tampered-completion",
          previous_dispatch_id: accepted.dispatch_id,
        }),
      }),
      (error) => error.classification === "external_closure_receipt_mismatch"
    );

    const voided = externalDispatchRecord({ dispatch_id: "dispatch-external-predecessor-tampered-terminal" });
    await helper.reserveDispatchRecord({ rootDir, record: voided });
    await helper.writeExternalClosureSlot({ rootDir, dispatchId: voided.dispatch_id, kind: "voided" });
    await helper.writeExternalVoidTerminalReceipt({ rootDir, dispatchId: voided.dispatch_id });
    const terminalPath = path.join(rootDir, voided.dispatch_id, "terminal-receipt.json");
    const terminal = JSON.parse(readFileSync(terminalPath, "utf8"));
    terminal.created_at = new Date(Date.parse(terminal.created_at) + 60_000).toISOString();
    writeFileSync(terminalPath, `${JSON.stringify(withRecomputedIntegrity(terminal))}\n`);
    await assert.rejects(
      () => helper.reserveDispatchRecord({
        rootDir,
        record: dispatchRecord({
          dispatch_id: "dispatch-runner-successor-tampered-terminal",
          head_ref_oid: "8888888888888888888888888888888888888888",
          attempt_id: "second-review-pr-1658-successor-tampered-terminal",
          previous_dispatch_id: voided.dispatch_id,
        }),
      }),
      (error) => error.classification === "external_closure_receipt_mismatch"
    );
  });
});

test("real concurrent accept-vs-void race on the same dispatch lets exactly one side win (separate OS processes)", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const dispatch = externalDispatchRecord({ dispatch_id: "dispatch-external-race" });
    await helper.reserveDispatchRecord({ rootDir, record: dispatch });
    const payload = externalReceiptPayload(dispatch);

    const acceptCode = `
      const result = await helper.writeExternalClosureSlot({
        rootDir,
        dispatchId: ${JSON.stringify(dispatch.dispatch_id)},
        kind: "accepted",
        receiptPayload: ${JSON.stringify(payload)},
      });
      process.stdout.write(JSON.stringify({ ok: true, kind: "accepted", status: result.status }));
    `;
    const voidCode = `
      const result = await helper.writeExternalClosureSlot({
        rootDir,
        dispatchId: ${JSON.stringify(dispatch.dispatch_id)},
        kind: "voided",
      });
      process.stdout.write(JSON.stringify({ ok: true, kind: "voided", status: result.status }));
    `;

    const [acceptResult, voidResult] = await Promise.all([
      runInChildProcess(rootDir, acceptCode),
      runInChildProcess(rootDir, voidCode),
    ]);
    const outcomes = [acceptResult, voidResult];
    const winners = outcomes.filter((outcome) => outcome.ok);
    const losers = outcomes.filter((outcome) => !outcome.ok);
    assert.equal(winners.length, 1, `exactly one racer must win: ${JSON.stringify(outcomes)}`);
    assert.equal(losers.length, 1);
    assert.equal(losers[0].classification, "external_dispatch_closed");

    const slot = helper.readDispatchEvidence({ rootDir, dispatchId: dispatch.dispatch_id }).externalClosure;
    assert.equal(slot.kind, winners[0].kind);

    if (winners[0].kind === "accepted") {
      const completion = await helper.writeExternalCompletionReceipt({ rootDir, dispatchId: dispatch.dispatch_id });
      assert.equal(completion.status, "created");
      await assert.rejects(
        () => helper.writeExternalVoidTerminalReceipt({ rootDir, dispatchId: dispatch.dispatch_id }),
        (error) => error.classification === "external_dispatch_closed"
      );
    } else {
      const terminal = await helper.writeExternalVoidTerminalReceipt({ rootDir, dispatchId: dispatch.dispatch_id });
      assert.equal(terminal.status, "created");
      await assert.rejects(
        () => helper.writeExternalCompletionReceipt({ rootDir, dispatchId: dispatch.dispatch_id }),
        (error) => error.classification === "external_dispatch_closed"
      );
    }
  });
});

test("an aged, marker-free, fully-closed external dispatch directory (including its slot) is reclaimable by cleanup", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();

    const accepted = externalDispatchRecord({ dispatch_id: "dispatch-external-cleanup-accepted" });
    await helper.reserveDispatchRecord({ rootDir, record: accepted });
    await helper.writeExternalClosureSlot({
      rootDir,
      dispatchId: accepted.dispatch_id,
      kind: "accepted",
      receiptPayload: externalReceiptPayload(accepted),
    });
    await helper.writeExternalCompletionReceipt({ rootDir, dispatchId: accepted.dispatch_id });
    // boundedDirectoryCleanupState treats any file not in evidence.paths (or
    // the usage-manifest companion allowlist) as "unknown" and refuses to
    // clean the directory at all — the slot file must be a known path.
    const result = await helper.cleanupDispatchEvidence({
      rootDir,
      dispatchId: accepted.dispatch_id,
      markerPresent: false,
      now: Date.now() + helper.COMPLETE_CHAIN_OWNER_TTL_MS + AGED_MARGIN_MS,
    });
    assert.equal(result.cleaned, true, JSON.stringify(result));
    assert.equal(existsSync(path.join(rootDir, accepted.dispatch_id)), false);

    const voided = externalDispatchRecord({ dispatch_id: "dispatch-external-cleanup-voided" });
    await helper.reserveDispatchRecord({ rootDir, record: voided });
    await helper.writeExternalClosureSlot({ rootDir, dispatchId: voided.dispatch_id, kind: "voided" });
    await helper.writeExternalVoidTerminalReceipt({ rootDir, dispatchId: voided.dispatch_id });
    const voidedResult = await helper.cleanupDispatchEvidence({
      rootDir,
      dispatchId: voided.dispatch_id,
      markerPresent: false,
      now: Date.now() + helper.COMPLETE_CHAIN_OWNER_TTL_MS + AGED_MARGIN_MS,
    });
    assert.equal(voidedResult.cleaned, true, JSON.stringify(voidedResult));
    assert.equal(existsSync(path.join(rootDir, voided.dispatch_id)), false);
  });
});

// strengthen-reviewer-model-selection T13 (D12; carrier lane): reviewer-model-record.json.

test("writeReviewerModelRecord persists the reviewer model record before completion seals, is idempotent under retry, and MUST NOT be appended after terminal evidence", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const record = dispatchRecord({ dispatch_id: "dispatch-reviewer-model-happy" });
    await helper.reserveDispatchRecord({ rootDir, record });
    const input = reviewerModelRecordInput(record);

    const first = await helper.writeReviewerModelRecord({ rootDir, record: input });
    assert.equal(first.status, "created");
    assert.equal(path.basename(first.path), "reviewer-model-record.json");
    const retry = await helper.writeReviewerModelRecord({ rootDir, record: input });
    assert.equal(retry.status, "idempotent");

    const evidence = helper.readDispatchEvidence({ rootDir, dispatchId: record.dispatch_id });
    assert.equal(evidence.reviewerModelRecord.schema, helper.REVIEWER_MODEL_RECORD_SCHEMA);
    assert.equal(evidence.reviewerModelRecord.requested_model, "opus");
    assert.equal(evidence.reviewerModelRecord.requested_source, "built-in-default");
    assert.equal(evidence.reviewerModelRecord.requested_source_env_var, "none");
    assert.equal(evidence.reviewerModelRecord.observed_model, "claude-opus-5");
    assert.equal(evidence.reviewerModelRecord.agreement, "alias-expansion-expected");

    // D12: "the record must precede completion sealing" is a structural
    // ordering guarantee, not a same-batch convention — once completion is
    // sealed, a (mistaken, out-of-order) write attempt fails closed instead
    // of silently overwriting or appending.
    await completeDispatch(helper, rootDir, record);
    await assert.rejects(
      () => helper.writeReviewerModelRecord({ rootDir, record: input }),
      (error) => error?.classification === "reviewer_dispatch_identity_collision"
    );
  });
});

// r3 finding F-srms-pr3-04: the dispatch record's `reviewer_family` holds the
// DECLARED family and the model record's family field holds the CLI recipe
// family. They disagree for every declared family whose CLI is codex
// (`openai-codex` -> `codex`), so one name over both value domains inside the
// same dispatch directory would silently mislabel the record. Pin the distinct
// names AND a case where the two values actually differ — identical values
// would let the overload return unnoticed.
test("the reviewer model record accepts OpenCode session-export identity and its two unavailable reasons", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const exact = externalDispatchRecord({
      dispatch_id: "dispatch-reviewer-model-opencode-exact",
      reviewer_family: "deepseek",
      reviewer_tool: "OpenCode",
    });
    await helper.reserveDispatchRecord({ rootDir, record: exact });
    await helper.writeReviewerModelRecord({
      rootDir,
      record: reviewerModelRecordInput(exact, {
        reviewer_cli_family: "opencode",
        requested_model: "deepseek/deepseek-v4-pro",
        requested_kind: "exact-id",
        observed_model: "deepseek/deepseek-v4-pro",
        observed_source: "session-export",
        agreement: "exact",
      }),
    });
    assert.equal(
      helper.readDispatchEvidence({ rootDir, dispatchId: exact.dispatch_id }).reviewerModelRecord.observed_source,
      "session-export"
    );

    for (const reason of ["export_unavailable", "export_invalid"]) {
      const record = externalDispatchRecord({
        dispatch_id: `dispatch-reviewer-model-opencode-${reason.replace("_", "-")}`,
        reviewer_family: "deepseek",
        reviewer_tool: "OpenCode",
      });
      await helper.reserveDispatchRecord({ rootDir, record });
      await helper.writeReviewerModelRecord({
        rootDir,
        record: reviewerModelRecordInput(record, {
          reviewer_cli_family: "opencode",
          requested_model: "deepseek/deepseek-v4-pro",
          requested_kind: "exact-id",
          observed_model: "none",
          observed_source: "none",
          observed_unavailable_reason: reason,
          agreement: "unavailable",
        }),
      });
    }

    const bogus = externalDispatchRecord({
      dispatch_id: "dispatch-reviewer-model-opencode-bogus",
      reviewer_family: "deepseek",
      reviewer_tool: "OpenCode",
    });
    await helper.reserveDispatchRecord({ rootDir, record: bogus });
    await assert.rejects(
      () => helper.writeReviewerModelRecord({
        rootDir,
        record: reviewerModelRecordInput(bogus, {
          reviewer_cli_family: "opencode",
          requested_model: "deepseek/deepseek-v4-pro",
          requested_kind: "exact-id",
          observed_model: "deepseek/deepseek-v4-pro",
          observed_source: "cli-echo",
          agreement: "exact",
        }),
      }),
      /observed_source is invalid/
    );
  });
});

test("the reviewer model record names the CLI family separately from the dispatch record's declared family", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const record = externalDispatchRecord({
      dispatch_id: "dispatch-reviewer-model-cli-family",
      reviewer_family: "openai-codex",
      reviewer_tool: "Codex CLI",
    });
    await helper.reserveDispatchRecord({ rootDir, record });
    await helper.writeReviewerModelRecord({
      rootDir,
      record: reviewerModelRecordInput(record, {
        reviewer_cli_family: "codex",
        requested_model: "gpt-5.6-sol",
        requested_kind: "exact-id",
        observed_model: "gpt-5.6-sol",
        observed_source: "isolated-home-rollout",
        agreement: "exact",
      }),
    });

    const evidence = helper.readDispatchEvidence({ rootDir, dispatchId: record.dispatch_id });
    assert.equal(evidence.reviewerModelRecord.reviewer_cli_family, "codex");
    assert.equal(evidence.dispatch.reviewer_family, "openai-codex");
    assert.equal(Object.hasOwn(evidence.reviewerModelRecord, "reviewer_family"), false);

    // A writer that kept the old name fails closed rather than producing a
    // second, differently-meant `reviewer_family` in this directory — but NOT
    // via assertExactFieldSet (r4 finding F-srms-pr4-02). writeReviewerModelRecord
    // builds the record from an explicit whitelist, so the stray `reviewer_family`
    // never reaches `built`, and the dropped `reviewer_cli_family` survives as an
    // own key whose value is undefined; assertExactFieldSet compares Object.keys()
    // and therefore passes. The actual rejection is assertIdentityField on that
    // undefined value, which is what the error-message assertion below pins.
    // (assertExactFieldSet guards the *other* regression: a builder reverted to
    // the old name, which would change the key set.)
    // Use a FRESH dispatch so the rejection can only come from the field, never
    // from write-once collision against the record written above.
    const untouched = externalDispatchRecord({
      dispatch_id: "dispatch-reviewer-model-stale-family",
      reviewer_family: "openai-codex",
      reviewer_tool: "Codex CLI",
    });
    await helper.reserveDispatchRecord({ rootDir, record: untouched });
    const stale = reviewerModelRecordInput(untouched, { reviewer_cli_family: "codex" });
    delete stale.reviewer_cli_family;
    stale.reviewer_family = "codex";
    await assert.rejects(
      () => helper.writeReviewerModelRecord({ rootDir, record: stale }),
      // `reviewer_dispatch_identity_collision` is this module's shared collision
      // class, so matching it alone would accept any failure (missing reservation,
      // terminal evidence already present, …). Pin the field too.
      (error) => error?.classification === "reviewer_dispatch_identity_collision"
        && /reviewer_cli_family/.test(error?.message ?? "")
    );
  });
});

test("assertReviewerModelRecord rejects a missing field, an extra field, and an out-of-closed-set value, each failing then green after correction", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const record = dispatchRecord({ dispatch_id: "dispatch-reviewer-model-fieldset" });
    await helper.reserveDispatchRecord({ rootDir, record });
    const written = await helper.writeReviewerModelRecord({
      rootDir,
      record: reviewerModelRecordInput(record),
    });
    const validBytes = readFileSync(written.path);
    const parsed = JSON.parse(validBytes.toString("utf8"));

    // (a) missing field: exact 17-field set drops to 16.
    const { agreement: _droppedAgreement, ...missingFieldRecord } = parsed;
    writeFileSync(written.path, `${JSON.stringify(withRecomputedIntegrity(missingFieldRecord))}\n`);
    assert.throws(
      () => helper.readDispatchEvidence({ rootDir, dispatchId: record.dispatch_id }),
      (error) => error?.classification === "reviewer_dispatch_identity_collision",
      "missing field must fail closed (red)"
    );
    writeFileSync(written.path, validBytes);
    assert.equal(
      helper.readDispatchEvidence({ rootDir, dispatchId: record.dispatch_id }).reviewerModelRecord.agreement,
      "alias-expansion-expected",
      "restoring the exact 17-field record must read clean again (green)"
    );

    // (b) extra field: exact 17-field set grows to 18.
    writeFileSync(
      written.path,
      `${JSON.stringify(withRecomputedIntegrity({ ...parsed, unexpected_field: "x" }))}\n`
    );
    assert.throws(
      () => helper.readDispatchEvidence({ rootDir, dispatchId: record.dispatch_id }),
      (error) => error?.classification === "reviewer_dispatch_identity_collision",
      "extra field must fail closed (red)"
    );
    writeFileSync(written.path, validBytes);
    assert.equal(
      helper.readDispatchEvidence({ rootDir, dispatchId: record.dispatch_id }).reviewerModelRecord.schema,
      helper.REVIEWER_MODEL_RECORD_SCHEMA,
      "restoring the exact 17-field record must read clean again (green)"
    );

    // (c) closed-set violation: field count stays 17, value is outside the allowlist.
    writeFileSync(
      written.path,
      `${JSON.stringify(withRecomputedIntegrity({ ...parsed, agreement: "not-a-real-agreement-value" }))}\n`
    );
    assert.throws(
      () => helper.readDispatchEvidence({ rootDir, dispatchId: record.dispatch_id }),
      (error) => error?.classification === "reviewer_dispatch_identity_collision",
      "closed-set violation must fail closed (red)"
    );
    writeFileSync(written.path, validBytes);
    assert.equal(
      helper.readDispatchEvidence({ rootDir, dispatchId: record.dispatch_id }).reviewerModelRecord.integrity_id,
      parsed.integrity_id,
      "restoring the exact 17-field record must read clean again (green)"
    );
  });
});

test("a completed dispatch directory with no reviewer-model-record.json (pre-migration shape) still reads and is TTL-reclaimable", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const record = dispatchRecord({ dispatch_id: "dispatch-reviewer-model-legacy" });
    await helper.reserveDispatchRecord({ rootDir, record });
    // No writeReviewerModelRecord call at all — this simulates a dispatch
    // directory sealed before this change existed (D12/D11: zero dual-read).
    await completeDispatch(helper, rootDir, record);

    const evidence = helper.readDispatchEvidence({ rootDir, dispatchId: record.dispatch_id });
    assert.equal(evidence.reviewerModelRecord, null);
    assert.equal(
      evidence.paths.reviewerModelRecord,
      path.join(rootDir, record.dispatch_id, "reviewer-model-record.json")
    );
    assert.equal(evidence.completion.dispatch_id, record.dispatch_id);

    const cleanup = await helper.cleanupDispatchEvidence({
      rootDir,
      dispatchId: record.dispatch_id,
      markerPresent: false,
      now: Date.now() + helper.COMPLETE_CHAIN_OWNER_TTL_MS + AGED_MARGIN_MS,
    });
    assert.equal(cleanup.cleaned, true, JSON.stringify(cleanup));
    assert.equal(existsSync(path.join(rootDir, record.dispatch_id)), false);
  });
});

test("a dispatch directory that carries reviewer-model-record.json remains TTL-reclaimable", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const record = dispatchRecord({ dispatch_id: "dispatch-reviewer-model-cleanup" });
    await helper.reserveDispatchRecord({ rootDir, record });
    await helper.writeReviewerModelRecord({ rootDir, record: reviewerModelRecordInput(record) });
    await completeDispatch(helper, rootDir, record);

    const evidence = helper.readDispatchEvidence({ rootDir, dispatchId: record.dispatch_id });
    assert.equal(evidence.reviewerModelRecord.schema, helper.REVIEWER_MODEL_RECORD_SCHEMA);

    // boundedDirectoryCleanupState treats any file not in evidence.paths (or
    // the usage-manifest companion allowlist) as unknown and refuses to clean
    // the directory at all — the new file must be a registered known path,
    // not a bare companion (design.md D12 reason 2).
    const cleanup = await helper.cleanupDispatchEvidence({
      rootDir,
      dispatchId: record.dispatch_id,
      markerPresent: false,
      now: Date.now() + helper.COMPLETE_CHAIN_OWNER_TTL_MS + AGED_MARGIN_MS,
    });
    assert.equal(cleanup.cleaned, true, JSON.stringify(cleanup));
    assert.equal(existsSync(path.join(rootDir, record.dispatch_id)), false);
  });
});

// fix-lineage-predecessor-diagnostics (Scenario: Missing predecessor
// reservation names cause and next step). The renderer prints only
// error.message, so the message itself must carry the named reason, the
// dispatch id, the resolved root, every possible cause, and the next step.
test("predecessor_reservation_missing: Missing predecessor reservation names cause and next step", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const expectedTtl = `${helper.COMPLETE_CHAIN_OWNER_TTL_MS / 3_600_000}h owner TTL`;
    const reclaimed = dispatchRecord({ dispatch_id: "dispatch-lineage-reclaimed" });
    await helper.reserveDispatchRecord({ rootDir, record: reclaimed });
    await completeDispatch(helper, rootDir, reclaimed);
    // Owner cleanup removes the whole directory and leaves no tombstone.
    const cleanup = await helper.cleanupDispatchEvidence({
      rootDir,
      dispatchId: reclaimed.dispatch_id,
      markerPresent: false,
      now: Date.now() + helper.COMPLETE_CHAIN_OWNER_TTL_MS + AGED_MARGIN_MS,
    });
    assert.equal(cleanup.cleaned, true, JSON.stringify(cleanup));

    for (const missingId of [reclaimed.dispatch_id, "dispatch-lineage-never-reserved"]) {
      const successor = dispatchRecord({
        dispatch_id: `dispatch-successor-of-${missingId}`,
        attempt_id: `second-review-pr-1658-abc123-successor-${missingId}`,
        previous_dispatch_id: missingId,
      });
      let caught;
      await assert.rejects(
        () => helper.reserveDispatchRecord({ rootDir, record: successor }),
        (error) => {
          caught = error;
          return true;
        }
      );
      assert.equal(caught.classification, "reviewer_dispatch_identity_collision");
      assert.match(caught.message, /^predecessor_reservation_missing: /);
      assert.ok(caught.message.includes(missingId), caught.message);
      assert.ok(caught.message.includes(path.resolve(rootDir)), caught.message);
      assert.ok(caught.message.includes(expectedTtl), caught.message);
      assert.match(caught.message, /never reserved \(or was rolled back by a failed render\)/);
      assert.match(caught.message, /DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR is (set|unset), or a render from another clone/);
      assert.ok(caught.message.includes(successor.dispatch_id), caught.message);
      assert.match(caught.message, /previous_dispatch_id names the direct predecessor/);
      assert.match(caught.message, /confirm the control-evidence root/);
      assert.match(caught.message, /restore exact original immutable predecessor evidence, then rerun/);
      assert.match(caught.message, /preserve the pending marker and escalate to TL/);
      assert.match(caught.message, /Only a new lineage with no pending marker or ancestor obligation may omit previous_dispatch_id/);
      assert.doesNotMatch(caught.message, /if the predecessor is truly absent, omit/);
      assert.equal(existsSync(path.join(rootDir, successor.dispatch_id)), false);
    }

    // The env disclosure uses controlEvidenceRoot's `??` presence test, so an
    // empty value (which resolves the root to cwd) still reports "set".
    const saved = process.env.DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR;
    const envCases = [[undefined, "unset"], ["", "set"], [rootDir, "set"]];
    try {
      for (const [value, expected] of envCases) {
        if (value === undefined) delete process.env.DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR;
        else process.env.DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR = value;
        await assert.rejects(
          () => helper.reserveDispatchRecord({
            rootDir,
            record: dispatchRecord({
              dispatch_id: `dispatch-env-case-${expected}-${String(value).length}`,
              attempt_id: `second-review-pr-1658-abc123-env-${expected}-${String(value).length}`,
              previous_dispatch_id: "dispatch-lineage-never-reserved",
            }),
          }),
          new RegExp(`DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR is ${expected},`)
        );
      }
    } finally {
      if (saved === undefined) delete process.env.DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR;
      else process.env.DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR = saved;
    }
  });
});

test("a reserved lineage approval id remains consumed in immutable dispatch evidence", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const approvalCommentId = "9001";
    const approvalCreatedAtIso = new Date().toISOString();
    const receipt = {
      schema: "devpro-second-review-lineage-approval/v1",
      repository_slug: "devpro/example",
      pr_number: "1658",
      source_state: "dispatch-marker",
      old_head_ref_oid: "b".repeat(40),
      new_head_ref_oid: "a".repeat(40),
      old_dispatch_id: "dispatch-11111111-1111-4111-8111-111111111111",
      action: "rebind",
      approval_comment_id: approvalCommentId,
      approval_comment_url: "https://github.com/devpro/example/pull/1658#issuecomment-9001",
      approver_login: "repo-owner",
      author_association: "OWNER",
      repository_permission: "write",
      created_at: approvalCreatedAtIso,
      updated_at: approvalCreatedAtIso,
      last_edited_at: null,
      user_content_edits_count: 0,
      comment_body_sha256: "c".repeat(64),
    };
    assert.deepEqual(
      helper.assertLineageApprovalNotConsumed({ rootDir, approvalCommentId }),
      { consumed: false },
    );
    const prior = dispatchRecord({
      dispatch_id: receipt.old_dispatch_id,
      head_ref_oid: receipt.old_head_ref_oid,
      attempt_id: "second-review-pr-1658-bbbbbbbbbbbb-initial-11111111-1111-4111-8111-111111111111",
    });
    await helper.reserveDispatchRecord({ rootDir, record: prior });
    await closeDispatchWithTerminal(helper, rootDir, prior);
    const record = dispatchRecord({
      dispatch_id: "dispatch-049ba0e0-c723-4b7b-a83c-9df0d9a0b990",
      head_ref_oid: "a".repeat(40),
      attempt_id: "second-review-pr-1658-aaaaaaaaaaaa-initial-049ba0e0-c723-4b7b-a83c-9df0d9a0b990",
      previous_dispatch_id: receipt.old_dispatch_id,
      lineage_approval_receipt_id: approvalCommentId,
      lineage_approval_receipt: receipt,
    });
    await reserveWithMarkerWitness(helper, rootDir, record);
    assert.throws(
      () => helper.assertLineageApprovalNotConsumed({ rootDir, approvalCommentId }),
      /already consumed by a dispatch reservation/u,
    );
    assert.throws(
      () => helper.rollbackUnclaimedDispatchReservation({ rootDir, record }),
      /consumed lineage approval reservation cannot be rolled back automatically/u,
    );
    assert.equal(existsSync(path.join(rootDir, record.dispatch_id, "dispatch.json")), true,
      "the immutable reservation remains the one-use audit record");
    const aborted = helper.writeLineageApprovalTransactionAbort({
      rootDir,
      record,
      transactionId: record.dispatch_id,
      reason: "post-reservation publication did not commit",
    });
    assert.equal(aborted.record.state, "aborted");
    assert.equal(aborted.record.approval_comment_id, approvalCommentId);
    assert.deepEqual([...helper.listConsumedLineageApprovalIds({ rootDir })], [approvalCommentId]);
    assert.equal(helper.writeLineageApprovalTransactionAbort({
      rootDir,
      record,
      transactionId: record.dispatch_id,
      reason: "post-reservation publication did not commit",
    }).status, "already-published");
    const approvalCreatedAt = Date.parse(receipt.created_at);
    assert.equal((await helper.cleanupDispatchEvidence({
      rootDir,
      dispatchId: record.dispatch_id,
      markerPresent: false,
      now: approvalCreatedAt + helper.LINEAGE_APPROVAL_MAX_AGE_MS,
    })).reason, "lineage-approval-audit-retained",
    "consumed approval IDs remain durable beyond ordinary owner TTL cleanup while the approval could still be accepted");
    assert.equal(existsSync(path.join(rootDir, record.dispatch_id, "dispatch.json")), true);
    assert.throws(
      () => helper.assertLineageApprovalNotConsumed({ rootDir, approvalCommentId }),
      /already consumed by a dispatch reservation/u,
      "a reconciled abort retains the one-use boundary",
    );
    // Past the age limit the resolver refuses this approval anyway, so the audit dispatch (with its
    // abort record) is reclaimed by ordinary cleanup instead of accumulating toward repository capacity.
    const retainedComponent = await helper.cleanupDispatchEvidence({
      rootDir, dispatchId: record.dispatch_id,
      now: approvalCreatedAt + helper.LINEAGE_APPROVAL_MAX_AGE_MS + 24 * 60 * 60 * 1000,
    });
    assert.equal(retainedComponent.reason, "owner-component-cleanup-required");
    assert.equal(existsSync(path.join(rootDir, record.dispatch_id)), true);
    const reclaimed = await helper.cleanupOwnedControlEvidence({ rootDir,
      now: approvalCreatedAt + helper.LINEAGE_APPROVAL_MAX_AGE_MS + 24 * 60 * 60 * 1000 });
    assert.equal(reclaimed.cleanedDirectories, 2);
    assert.equal(existsSync(path.join(rootDir, record.dispatch_id)), false);
    assert.equal(helper.listConsumedLineageApprovalIds({ rootDir }).size, 0);
  });
});

test("a lineage approval receipt URL must name this dispatch's repository, PR and approval comment", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const approvalCommentId = "9002";
    const receipt = {
      schema: "devpro-second-review-lineage-approval/v1",
      repository_slug: "devpro/example",
      pr_number: "1658",
      source_state: "dispatch-marker",
      old_head_ref_oid: "b".repeat(40),
      new_head_ref_oid: "a".repeat(40),
      old_dispatch_id: "dispatch-11111111-1111-4111-8111-111111111111",
      action: "rebind",
      approval_comment_id: approvalCommentId,
      approval_comment_url: `https://github.com/devpro/example/pull/1658#issuecomment-${approvalCommentId}`,
      approver_login: "repo-owner",
      author_association: "OWNER",
      repository_permission: "write",
      created_at: "2026-09-28T00:20:00Z",
      updated_at: "2026-09-28T00:20:00Z",
      last_edited_at: null,
      user_content_edits_count: 0,
      comment_body_sha256: "c".repeat(64),
    };
    const prior = dispatchRecord({
      dispatch_id: receipt.old_dispatch_id,
      head_ref_oid: receipt.old_head_ref_oid,
      attempt_id: "second-review-pr-1658-bbbbbbbbbbbb-initial-11111111-1111-4111-8111-111111111111",
    });
    await helper.reserveDispatchRecord({ rootDir, record: prior });
    await closeDispatchWithTerminal(helper, rootDir, prior);
    const withReceipt = (overrides, suffix) => dispatchRecord({
      dispatch_id: `dispatch-049ba0e0-c723-4b7b-a83c-9df0d9a0b99${suffix}`,
      head_ref_oid: "a".repeat(40),
      attempt_id: `second-review-pr-1658-aaaaaaaaaaaa-initial-049ba0e0-c723-4b7b-a83c-9df0d9a0b99${suffix}`,
      previous_dispatch_id: receipt.old_dispatch_id,
      lineage_approval_receipt_id: approvalCommentId,
      lineage_approval_receipt: { ...receipt, ...overrides },
    });
    // Each URL is well-formed GitHub comment URL, but points at another repository, PR or comment.
    const wrongUrls = [
      "https://github.com/devpro/other/pull/1658#issuecomment-9002",
      "https://github.com/devpro/example/pull/1659#issuecomment-9002",
      "https://github.com/devpro/example/pull/1658#issuecomment-9003",
    ];
    for (const [index, approval_comment_url] of wrongUrls.entries()) {
      await assert.rejects(
        () => helper.reserveDispatchRecord({ rootDir, record: withReceipt({ approval_comment_url }, String(index)) }),
        /lineage approval receipt does not match the immutable dispatch lineage/u,
        approval_comment_url,
      );
    }
    await reserveWithMarkerWitness(helper, rootDir, withReceipt({}, "5"));
  });
});

// fix-dispatch-predecessor-lineage prove-it: isolated roots, no default-state writes.
test("lineage lifetime RED: standalone cross-head requires exact marker witness", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const prior = dispatchRecord({ dispatch_id: "dispatch-witness-prior" });
    await helper.reserveDispatchRecord({ rootDir, record: prior });
    await closeDispatchWithTerminal(helper, rootDir, prior);
    const successor = dispatchRecord({ dispatch_id: "dispatch-witness-next", previous_dispatch_id: prior.dispatch_id,
      head_ref_oid: "def456", attempt_id: "second-review-pr-1658-def456-next" });
    await assert.rejects(helper.reserveDispatchRecord({ rootDir, record: successor }), /marker.*witness/i);
    assert.equal(existsSync(path.join(rootDir, successor.dispatch_id)), false);
  });
});

test("lineage lifetime RED: fresh successor protects aged predecessor without markers", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const prior = dispatchRecord({ dispatch_id: "dispatch-lifetime-prior" });
    await helper.reserveDispatchRecord({ rootDir, record: prior });
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    for (const name of readdirSync(path.join(rootDir, prior.dispatch_id))) {
      utimesSync(path.join(rootDir, prior.dispatch_id, name), old, old);
    }
    const successor = dispatchRecord({ dispatch_id: "dispatch-lifetime-next", previous_dispatch_id: prior.dispatch_id,
      attempt_id: "second-review-pr-1658-abc123-next" });
    await helper.reserveDispatchRecord({ rootDir, record: successor });
    await helper.cleanupOwnedControlEvidence({ rootDir, activeMarkers: [] });
    assert.equal(existsSync(path.join(rootDir, prior.dispatch_id, "dispatch.json")), true,
      "a fresh successor must retain its complete predecessor component");
  });
});

test("cross-head marker witness exact canonical authority matrix, same-head and exact-byte idempotence", async () => {
  await withTempDir(async (rootDir) => {
    const helper = await loadHelper();
    const state = await import("../hooks/lib/post-pr-completion-state.mjs");
    const prior = dispatchRecord({ dispatch_id: "dispatch-matrix-old", head_ref_oid: "a".repeat(40) });
    await helper.reserveDispatchRecord({ rootDir, record: prior }); await closeDispatchWithTerminal(helper, rootDir, prior);
    const next = dispatchRecord({ dispatch_id: "dispatch-matrix-new", head_ref_oid: "b".repeat(40),
      attempt_id: "attempt-matrix-new", previous_dispatch_id: prior.dispatch_id });
    const file = state.writePostPrCompletionMarker({ cwd: rootDir, prNumber: prior.pr_number,
      repositorySlug: prior.repository_slug, headRefOid: prior.head_ref_oid, expectedDispatchId: prior.dispatch_id, sessionId: "" });
    const bytes = readFileSync(file), snapshot = JSON.parse(bytes), digest = createHash("sha256").update(bytes).digest("hex");
    const witness = { file, snapshot, sha256: digest };
    const matrix = [
      ["missing", null], ["wrong-path", { ...witness, file: path.join(rootDir, "caller-chosen.json") }],
      ["stale-digest", { ...witness, sha256: "0".repeat(64) }],
      ["wrong-authority", { ...witness, snapshot: { ...snapshot, authorityId: "other" } }],
      ["wrong-repository", { ...witness, snapshot: { ...snapshot, repository_slug: "devpro/other" } }],
      ["wrong-pr", { ...witness, snapshot: { ...snapshot, prNumber: "9" } }],
      ["wrong-head", { ...witness, snapshot: { ...snapshot, head_ref_oid: "c".repeat(40) } }],
      ["wrong-dispatch", { ...witness, snapshot: { ...snapshot, expected_dispatch_id: "dispatch-other" } }],
    ];
    for (const [name, predecessorMarker] of matrix) {
      await assert.rejects(helper.reserveDispatchRecord({ rootDir, record: next, predecessorMarker }),
        (error) => error.classification === "reviewer_dispatch_identity_collision" && /exact canonical predecessor marker witness/.test(error.message), name);
      assert.equal(existsSync(path.join(rootDir, next.dispatch_id)), false, name);
    }
    const duplicate = path.join(path.dirname(file), "pending-post-pr-completion-duplicate.json");
    writeFileSync(duplicate, bytes);
    await assert.rejects(helper.reserveDispatchRecord({ rootDir, record: next, predecessorMarker: witness }), /marker witness/);
    rmSync(duplicate);
    writeFileSync(file, "{");
    await assert.rejects(helper.reserveDispatchRecord({ rootDir, record: next, predecessorMarker: witness }), /marker witness/);
    writeFileSync(file, bytes);
    assert.equal((await helper.reserveDispatchRecord({ rootDir, record: next, predecessorMarker: witness })).status, "created");
    rmSync(file);
    assert.equal((await helper.reserveDispatchRecord({ rootDir, record: next })).status, "idempotent",
      "CAS advanced/removed old marker must not block exact-byte history reread");
    const retry = { ...next, dispatch_id: "dispatch-matrix-retry", attempt_id: "attempt-matrix-retry", previous_dispatch_id: next.dispatch_id };
    assert.equal((await helper.reserveDispatchRecord({ rootDir, record: retry })).status, "created",
      "same-head retry needs no cross-head witness");
    await assert.rejects(helper.reserveDispatchRecord({ rootDir, record: { ...next, packet_sha256: "d".repeat(64) } }), /collision/);
  });
});
