import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import os from "node:os";
import * as controlEvidence from "../hooks/lib/second-review-control-evidence.mjs";
import { attemptLockPath, lockOwnerState } from "../lib/second-review-attempt-lock.mjs";
import { REPO_ROOT } from "./lib/repo-root.mjs";

const pruneScript = path.join(REPO_ROOT, ".devpro", "scripts", "prune-notes-tmp.mjs");
const plannerExportName = "__testCrossReviewAttemptPlanner";
const pruneSource = await fs.readFile(pruneScript, "utf8");
const plannerExportDeclared = new RegExp(
  `export\\s+async\\s+function\\s+${plannerExportName}\\b`
).test(pruneSource);
const pruneModule = plannerExportDeclared
  ? await import(`${pathToFileURL(pruneScript).href}?attempt-planner-contract=${Date.now()}`)
  : null;
const attemptPlanner = pruneModule?.[plannerExportName] ?? null;
const plannerSkip = attemptPlanner === null
  ? `${plannerExportName} is not implemented yet`
  : false;
const fixtureNowMs = Date.now();

const cleanupRoots = [];

async function createRepo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "prune-notes-tmp-"));
  cleanupRoots.push(dir);
  execSync("git init -q -b main", { cwd: dir });
  await fs.mkdir(path.join(dir, "notes", "tmp", "state", "devpro-recap-state"), {
    recursive: true,
  });
  return dir;
}

async function writeFileWithAge(repo, rel, content, ageMinutes) {
  const file = path.join(repo, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  const when = new Date(Date.now() - ageMinutes * 60_000);
  await fs.utimes(file, when, when);
  return file;
}

async function exists(file) {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

function run(repo, args = []) {
  return spawnSync(process.execPath, [pruneScript, ...args], {
    cwd: repo,
    encoding: "utf8",
  });
}

const nowIso = () => new Date().toISOString();

function attemptRoot(repo, attemptId) {
  return path.join(repo, "notes", "cross-review", attemptId);
}

function controlRoot(repo) {
  return path.join(repo, "notes", "tmp", "state", "devpro-second-review-control-evidence");
}

async function setTreeAge(root, ageMinutes) {
  const when = new Date(fixtureNowMs - ageMinutes * 60_000);
  const visit = async (entryPath) => {
    const stat = await fs.lstat(entryPath);
    if (stat.isDirectory()) {
      for (const entry of await fs.readdir(entryPath)) {
        await visit(path.join(entryPath, entry));
      }
    }
    await fs.utimes(entryPath, when, when);
  };
  await visit(root);
}

async function createAttempt(repo, attemptId, {
  terminal = "success",
  ageMinutes = 120,
} = {}) {
  const root = attemptRoot(repo, attemptId);
  const contextPath = path.join(root, "observability-context.json");
  const packetPath = path.join(root, "packet.md");
  const evidenceRoot = controlRoot(repo);
  const dispatchId = `dispatch-${attemptId}`;
  const packetBytes = Buffer.from(`# packet for ${attemptId}\n`, "utf8");
  const context = {
    attempt_id: attemptId,
    dispatch_id: dispatchId,
    previous_dispatch_id: null,
    repository_slug: "devpro/example",
    pr_number: "1834",
    head_ref_oid: "abc123",
    context_path: contextPath,
    observability_context_path: contextPath,
    packet_path: packetPath,
    control_evidence_root: evidenceRoot,
  };
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(contextPath, `${JSON.stringify(context, null, 2)}\n`);
  await fs.writeFile(packetPath, packetBytes);

  const record = controlEvidence.secondReviewDispatchRecord({ context, packetBytes });
  await controlEvidence.reserveDispatchRecord({ rootDir: evidenceRoot, record });
  if (terminal === "success") {
    await controlEvidence.claimDispatchInvocation({ rootDir: evidenceRoot, record });
    await controlEvidence.writeCompletionReceipt({
      rootDir: evidenceRoot,
      record: {
        ...record,
        schema: controlEvidence.COMPLETION_SCHEMA,
        outcome: "reviewer_process_closed_and_sticky_verified",
        classification: "sticky_verified",
        sticky_verdict: "PASS",
        sticky_last_reviewed_sha: record.head_ref_oid,
        sticky_dispatch_id: record.dispatch_id,
        sticky_comment_id: 1834,
        sticky_comment_url: "https://github.com/devpro/example/pull/1834#issuecomment-1834",
        process_close_observed: true,
      },
    });
  } else if (terminal === "known-failure") {
    const classification = "reviewer_cli_spawn_failed";
    await controlEvidence.writeTerminalReceipt({
      rootDir: evidenceRoot,
      record: {
        ...record,
        schema: controlEvidence.TERMINAL_RECEIPT_SCHEMA,
        outcome_group: controlEvidence.terminalReceiptOutcomeGroup(classification),
        classification,
        responsibility: controlEvidence.TERMINAL_RECEIPT_RESPONSIBILITY,
        created_at: new Date(fixtureNowMs - ageMinutes * 60_000).toISOString(),
        process_spawned: false,
        lifecycle_phase: "pre_spawn_known_terminal",
        process_close_observed: false,
        transport_cleanup_confirmed: true,
        invocation_claim_sha256: null,
      },
    });
  } else {
    assert.equal(terminal, "nonterminal", `unknown terminal fixture state: ${terminal}`);
  }
  await setTreeAge(root, ageMinutes);
  return { root, contextPath, evidenceRoot, dispatchId, context, record };
}

async function addContradictoryTerminalEvidence(attempt) {
  const evidence = controlEvidence.readDispatchEvidence({
    rootDir: attempt.evidenceRoot,
    dispatchId: attempt.dispatchId,
  });
  const classification = "reviewer_completion_critical";
  const identity = {
    schema: controlEvidence.TERMINAL_RECEIPT_SCHEMA,
    repository_slug: attempt.record.repository_slug,
    pr_number: attempt.record.pr_number,
    head_ref_oid: attempt.record.head_ref_oid,
    attempt_id: attempt.record.attempt_id,
    dispatch_id: attempt.record.dispatch_id,
    previous_dispatch_id: attempt.record.previous_dispatch_id,
    outcome_group: controlEvidence.terminalReceiptOutcomeGroup(classification),
    classification,
    responsibility: controlEvidence.TERMINAL_RECEIPT_RESPONSIBILITY,
    created_at: new Date(fixtureNowMs - 120 * 60_000).toISOString(),
    process_spawned: true,
    lifecycle_phase: "post_close_transport_cleaned",
    process_close_observed: true,
    transport_cleanup_confirmed: true,
    invocation_claim_sha256: controlEvidence.canonicalInvocationClaimSha256(
      evidence.invocationClaim
    ),
  };
  const integrity_id = await crypto.subtle.digest(
    "SHA-256",
    Buffer.from(JSON.stringify(identity), "utf8")
  );
  const terminal = {
    ...identity,
    integrity_id: Buffer.from(integrity_id).toString("hex"),
  };
  await fs.writeFile(
    path.join(attempt.evidenceRoot, attempt.dispatchId, "terminal-receipt.json"),
    `${JSON.stringify(terminal)}\n`
  );
}

async function writeAttemptLock(attempt, { pid, malformed = false } = {}) {
  const lockPath = attemptLockPath(attempt.contextPath);
  const owner = malformed
    ? "not-json\n"
    : `${JSON.stringify({
        attempt_id: attempt.record.attempt_id,
        pid,
        created_at: new Date(fixtureNowMs).toISOString(),
        owner_token: `owner-${attempt.record.attempt_id}`,
      })}\n`;
  await fs.writeFile(lockPath, owner);
  return lockPath;
}

async function persistentSnapshot(root) {
  const entries = [];
  const visit = async (entryPath) => {
    const rel = path.relative(root, entryPath).split(path.sep).join("/");
    if (path.basename(entryPath).startsWith("observability-context.json.attempt.lock")) return;
    const stat = await fs.lstat(entryPath);
    if (stat.isDirectory()) {
      if (rel) entries.push(`dir:${rel}`);
      for (const entry of (await fs.readdir(entryPath)).sort()) {
        await visit(path.join(entryPath, entry));
      }
    } else if (stat.isFile()) {
      entries.push(`file:${rel}:${(await fs.readFile(entryPath)).toString("base64")}`);
    } else {
      entries.push(`other:${rel}`);
    }
  };
  await visit(root);
  return entries;
}

function plannerDependencies(overrides = {}) {
  return {
    readDispatchEvidence: controlEvidence.readDispatchEvidence,
    signalOwner(pid) {
      if (pid === 41001) return;
      if (pid === 41002) {
        const error = new Error("injected owner visibility denial");
        error.code = "EPERM";
        throw error;
      }
      if (pid === 41003) {
        const error = new Error("injected dead owner");
        error.code = "ESRCH";
        throw error;
      }
      throw new Error(`unexpected fixture pid: ${pid}`);
    },
    removeAttemptRoot: (root) => fs.rm(root, { recursive: true, force: true }),
    ...overrides,
  };
}

async function planAttempts(repo, {
  execute = true,
  limit = 50,
  dependencies = plannerDependencies(),
} = {}) {
  return attemptPlanner({
    carrierRoot: path.join(repo, "notes", "cross-review"),
    execute,
    limit,
    maxAgeMinutes: 60,
    nowMs: fixtureNowMs,
  }, dependencies);
}

function outcomeFor(result, attemptId) {
  assert.ok(Array.isArray(result?.attempts), "planner result must expose attempts[]");
  const outcome = result.attempts.find((entry) => entry.attempt_id === attemptId);
  assert.ok(outcome, `planner result must include ${attemptId}`);
  assert.equal(typeof outcome.reason, "string", `${attemptId} must have a stable reason code`);
  assert.ok(Buffer.byteLength(outcome.reason, "utf8") <= 256, "reason must remain bounded");
  return outcome;
}

function assertClassificationLine(stdout, attemptId, classification) {
  const line = stdout.split(/\r?\n/).find(
    (candidate) => candidate.includes(attemptId) && candidate.includes(classification)
  );
  assert.ok(line, `output must report ${attemptId} as ${classification}; stdout:\n${stdout}`);
}

after(async () => {
  for (const dir of cleanupRoots) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("prune-notes-tmp", () => {
  it("builds canonical terminal, nonterminal, contradictory, and owner-state fixtures", async () => {
    const repo = await createRepo();
    const success = await createAttempt(repo, "fixture-terminal-success");
    const failure = await createAttempt(repo, "fixture-terminal-failure", {
      terminal: "known-failure",
    });
    const nonterminal = await createAttempt(repo, "fixture-nonterminal", {
      terminal: "nonterminal",
    });
    const contradictory = await createAttempt(repo, "fixture-contradictory");
    const live = await createAttempt(repo, "fixture-live-lock");
    const unknown = await createAttempt(repo, "fixture-unknown-lock");
    const dead = await createAttempt(repo, "fixture-dead-lock");
    const malformed = await createAttempt(repo, "fixture-malformed-lock");

    assert.ok(controlEvidence.readDispatchEvidence({
      rootDir: success.evidenceRoot,
      dispatchId: success.dispatchId,
    }).completion);
    assert.ok(controlEvidence.readDispatchEvidence({
      rootDir: failure.evidenceRoot,
      dispatchId: failure.dispatchId,
    }).terminal);
    const incomplete = controlEvidence.readDispatchEvidence({
      rootDir: nonterminal.evidenceRoot,
      dispatchId: nonterminal.dispatchId,
    });
    assert.equal(incomplete.completion, null);
    assert.equal(incomplete.terminal, null);

    await addContradictoryTerminalEvidence(contradictory);
    assert.throws(
      () => controlEvidence.readDispatchEvidence({
        rootDir: contradictory.evidenceRoot,
        dispatchId: contradictory.dispatchId,
      }),
      /mutually exclusive/
    );

    const livePath = await writeAttemptLock(live, { pid: 41001 });
    const unknownPath = await writeAttemptLock(unknown, { pid: 41002 });
    const deadPath = await writeAttemptLock(dead, { pid: 41003 });
    const malformedPath = await writeAttemptLock(malformed, { malformed: true });
    const { signalOwner } = plannerDependencies();
    assert.equal(lockOwnerState(livePath, { signalOwner }).state, "live");
    assert.equal(lockOwnerState(unknownPath, { signalOwner }).state, "unknown");
    assert.equal(lockOwnerState(deadPath, { signalOwner }).state, "dead");
    assert.equal(lockOwnerState(malformedPath, { signalOwner }).state, "malformed");
  });

  it("exports the production cross-review attempt planner test seam", () => {
    assert.equal(
      plannerExportDeclared,
      true,
      `${plannerExportName} must be an exported async function backed by the production planner`
    );
    assert.equal(typeof attemptPlanner, "function");
  });

  it("reports malformed direct-child files and symlinks without removing them", {
    skip: plannerSkip,
  }, async () => {
    const repo = await createRepo();
    const carrierRoot = path.join(repo, "notes", "cross-review");
    const fileId = "f".repeat(129);
    const boundedFileId = "f".repeat(128);
    const symlinkId = "attempt-root-is-symlink";
    const filePath = path.join(carrierRoot, fileId);
    const symlinkPath = path.join(carrierRoot, symlinkId);
    await fs.mkdir(carrierRoot, { recursive: true });
    await fs.writeFile(filePath, "not an attempt directory\n");
    await fs.symlink(filePath, symlinkPath);

    const result = await planAttempts(repo);

    assert.equal(result.attempts.length, 2);
    for (const attemptId of [boundedFileId, symlinkId]) {
      const outcome = outcomeFor(result, attemptId);
      assert.equal(outcome.classification, "invalid-evidence-skipped");
      assert.equal(outcome.reason, "attempt-root-shape-invalid");
      assert.ok(Buffer.byteLength(outcome.attempt_id, "utf8") <= 128);
    }
    assert.equal((await fs.lstat(filePath)).isFile(), true);
    assert.equal((await fs.lstat(symlinkPath)).isSymbolicLink(), true);

    const cliResult = run(repo, ["--exec", "--as-of", nowIso(), "--limit", "0"]);
    assert.equal(cliResult.status, 0, cliResult.stderr);
    assert.match(cliResult.stdout, /invalid-evidence-skipped: 2 attempts/);
    assert.equal((await fs.lstat(filePath)).isFile(), true);
    assert.equal((await fs.lstat(symlinkPath)).isSymbolicLink(), true);
  });

  it("wires the attempt planner into exec CLI classification and root removal", {
    skip: plannerSkip,
  }, async () => {
    const repo = await createRepo();
    const attemptId = "attempt-cli-terminal-expired";
    const attempt = await createAttempt(repo, attemptId);

    const result = run(repo, ["--exec", "--as-of", nowIso()]);

    assert.equal(result.status, 0, result.stderr);
    assertClassificationLine(result.stdout, attemptId, "deleted");
    assert.equal(await exists(attempt.root), false);
  });

  it("deletes expired inactive attempts with either canonical terminal receipt", {
    skip: plannerSkip,
  }, async () => {
    const repo = await createRepo();
    const successId = "attempt-terminal-success-expired";
    const failureId = "attempt-terminal-known-failure-expired";
    const success = await createAttempt(repo, successId, { terminal: "success" });
    const failure = await createAttempt(repo, failureId, { terminal: "known-failure" });
    const removed = [];

    const result = await planAttempts(repo, {
      dependencies: plannerDependencies({
        async removeAttemptRoot(root) {
          removed.push(root);
          await fs.rm(root, { recursive: true, force: true });
        },
      }),
    });

    assert.equal(outcomeFor(result, successId).classification, "deleted");
    assert.equal(outcomeFor(result, failureId).classification, "deleted");
    assert.deepEqual(removed.sort(), [success.root, failure.root].sort());
    assert.equal(await exists(success.root), false);
    assert.equal(await exists(failure.root), false);
  });

  it("maps deterministic live and unknown owners to active-skipped", {
    skip: plannerSkip,
  }, async () => {
    const repo = await createRepo();
    const liveId = "attempt-live-owner";
    const unknownId = "attempt-unknown-owner";
    const live = await createAttempt(repo, liveId);
    const unknown = await createAttempt(repo, unknownId);
    await writeAttemptLock(live, { pid: 41001 });
    await writeAttemptLock(unknown, { pid: 41002 });

    const result = await planAttempts(repo, { limit: 1 });

    assert.equal(outcomeFor(result, liveId).classification, "active-skipped");
    assert.equal(outcomeFor(result, unknownId).classification, "active-skipped");
    assert.equal(await exists(live.root), true);
    assert.equal(await exists(unknown.root), true);
  });

  it("keeps canonical incomplete attempts as nonterminal-skipped", {
    skip: plannerSkip,
  }, async () => {
    const repo = await createRepo();
    const attemptId = "attempt-nonterminal";
    const attempt = await createAttempt(repo, attemptId, { terminal: "nonterminal" });
    const before = await persistentSnapshot(attempt.root);

    const result = await planAttempts(repo);

    assert.equal(outcomeFor(result, attemptId).classification, "nonterminal-skipped");
    assert.deepEqual(await persistentSnapshot(attempt.root), before);
  });

  it("fails closed for malformed, contradictory, escaped-root, malformed-lock, and dead-lock attempts", {
    skip: plannerSkip,
  }, async () => {
    const repo = await createRepo();
    const malformedId = "attempt-malformed-context";
    const contradictoryId = "attempt-contradictory-terminal";
    const escapedRootId = "attempt-escaped-evidence-root";
    const malformedLockId = "attempt-malformed-lock";
    const deadLockId = "attempt-dead-lock";
    const malformed = await createAttempt(repo, malformedId);
    const contradictory = await createAttempt(repo, contradictoryId);
    const escapedRoot = await createAttempt(repo, escapedRootId);
    const malformedLock = await createAttempt(repo, malformedLockId);
    const deadLock = await createAttempt(repo, deadLockId);
    await fs.writeFile(malformed.contextPath, "{not-json\n");
    await addContradictoryTerminalEvidence(contradictory);
    const siblingEvidenceRoot = path.join(repo, "notes", "tmp", "state", "unexpected-evidence-root");
    await fs.cp(escapedRoot.evidenceRoot, siblingEvidenceRoot, { recursive: true });
    await fs.writeFile(escapedRoot.contextPath, `${JSON.stringify({
      ...escapedRoot.context,
      control_evidence_root: siblingEvidenceRoot,
    }, null, 2)}\n`);
    await setTreeAge(escapedRoot.root, 120);
    await writeAttemptLock(malformedLock, { malformed: true });
    await writeAttemptLock(deadLock, { pid: 41003 });

    const result = await planAttempts(repo);

    for (const [attemptId, attempt] of [
      [malformedId, malformed],
      [contradictoryId, contradictory],
      [escapedRootId, escapedRoot],
      [malformedLockId, malformedLock],
      [deadLockId, deadLock],
    ]) {
      assert.equal(outcomeFor(result, attemptId).classification, "invalid-evidence-skipped");
      assert.equal(await exists(attempt.root), true);
    }
  });

  it("uses whole-attempt TTL and never partially removes an attempt with one fresh carrier", {
    skip: plannerSkip,
  }, async () => {
    const repo = await createRepo();
    const attemptId = "attempt-terminal-with-fresh-heartbeat";
    const attempt = await createAttempt(repo, attemptId);
    await writeFileWithAge(
      repo,
      `notes/cross-review/${attemptId}/heartbeat.json`,
      "{}\n",
      10
    );
    const before = await persistentSnapshot(attempt.root);

    const result = await planAttempts(repo);

    assert.equal(outcomeFor(result, attemptId).classification, "ttl-skipped");
    assert.deepEqual(await persistentSnapshot(attempt.root), before);
  });

  it("continues evaluating an eligible sibling after invalid evidence", {
    skip: plannerSkip,
  }, async () => {
    const repo = await createRepo();
    const badId = "attempt-a-bad-context";
    const goodId = "attempt-z-eligible";
    const bad = await createAttempt(repo, badId);
    const good = await createAttempt(repo, goodId);
    await fs.writeFile(bad.contextPath, "[]\n");

    const result = await planAttempts(repo);

    assert.equal(outcomeFor(result, badId).classification, "invalid-evidence-skipped");
    assert.equal(outcomeFor(result, goodId).classification, "deleted");
    assert.equal(await exists(bad.root), true);
    assert.equal(await exists(good.root), false);
  });

  it("keeps dry-run advisory and read-only without acquiring ownership", {
    skip: plannerSkip,
  }, async () => {
    const repo = await createRepo();
    const attemptId = "attempt-dry-run-terminal";
    const attempt = await createAttempt(repo, attemptId);
    const before = await persistentSnapshot(attempt.root);
    let removeCalls = 0;

    const result = await planAttempts(repo, {
      execute: false,
      dependencies: plannerDependencies({
        removeAttemptRoot() {
          removeCalls += 1;
          throw new Error("dry-run reached remover");
        },
      }),
    });

    assert.notEqual(outcomeFor(result, attemptId).classification, "deleted");
    assert.equal(removeCalls, 0);
    assert.deepEqual(await persistentSnapshot(attempt.root), before);
    assert.equal(await exists(attemptLockPath(attempt.contextPath)), false);
  });

  it("contains planner faults to one attempt with zero carrier mutation", {
    skip: plannerSkip,
  }, async () => {
    const repo = await createRepo();
    const faultId = "attempt-reader-fault";
    const siblingId = "attempt-reader-fault-sibling";
    const fault = await createAttempt(repo, faultId);
    const sibling = await createAttempt(repo, siblingId);
    const before = await persistentSnapshot(fault.root);

    const result = await planAttempts(repo, {
      dependencies: plannerDependencies({
        readDispatchEvidence(input) {
          if (input.dispatchId === fault.dispatchId) {
            throw new Error("injected planner evidence read fault");
          }
          return controlEvidence.readDispatchEvidence(input);
        },
      }),
    });

    assert.equal(outcomeFor(result, faultId).classification, "invalid-evidence-skipped");
    assert.deepEqual(await persistentSnapshot(fault.root), before);
    assert.equal(outcomeFor(result, siblingId).classification, "deleted");
    assert.equal(await exists(sibling.root), false);
  });

  it("makes a pre-effect root remover error fail-visible without reporting deleted", {
    skip: plannerSkip,
  }, async () => {
    const repo = await createRepo();
    const attemptId = "attempt-remove-fault";
    const attempt = await createAttempt(repo, attemptId);
    const before = await persistentSnapshot(attempt.root);
    const injected = new Error("injected attempt-root remove failure before effect");

    await assert.rejects(
      planAttempts(repo, {
        dependencies: plannerDependencies({
          removeAttemptRoot() {
            throw injected;
          },
        }),
      }),
      (error) => {
        assert.match(error.message, /injected attempt-root remove failure before effect/);
        assert.doesNotMatch(error.message, /deleted/i);
        return true;
      }
    );
    assert.deepEqual(await persistentSnapshot(attempt.root), before);
  });

  it("dry-runs stale known files without deleting unknown or state files", async () => {
    const repo = await createRepo();
    const body = await writeFileWithAge(repo, "notes/tmp/remove-gh-body-pr-body-prune.md", "body\n", 120);
    const fresh = await writeFileWithAge(repo, "notes/tmp/full-suite.log", "log\n", 10);
    const unknown = await writeFileWithAge(repo, "notes/tmp/mystery.bin", "?\n", 120);
    const state = await writeFileWithAge(repo, "notes/tmp/state/devpro-recap-state/key", "", 120);

    const result = run(repo);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /notes\/tmp prune dry-run/);
    assert.match(result.stdout, /state skipped: 1 files/);
    assert.match(result.stdout, /fresh known skipped: 1 files/);
    assert.match(result.stdout, /unknown skipped: 1 files/);
    assert.match(result.stdout, /candidates: 1 files/);
    assert.match(result.stdout, /body\s+\d+ B\s+remove-gh-body-pr-body-prune\.md/);
    assert.match(result.stdout, /unknown files \(not deleted by default\):/);
    assert.match(result.stdout, /mystery\.bin/);
    await assert.doesNotReject(fs.stat(body));
    await assert.doesNotReject(fs.stat(fresh));
    await assert.doesNotReject(fs.stat(unknown));
    await assert.doesNotReject(fs.stat(state));
  });

  it("--exec deletes stale known non-state files only", async () => {
    const repo = await createRepo();
    const body = await writeFileWithAge(repo, "notes/tmp/recap-example.md", "body\n", 120);
    const log = await writeFileWithAge(repo, "notes/tmp/test-output.log", "log\n", 120);
    const fresh = await writeFileWithAge(repo, "notes/tmp/fresh.log", "log\n", 10);
    const unknown = await writeFileWithAge(repo, "notes/tmp/unknown.bin", "?\n", 120);
    const state = await writeFileWithAge(repo, "notes/tmp/state/devpro-postmerge-state/marker", "", 120);

    const result = run(repo, ["--exec", "--as-of", nowIso()]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /notes\/tmp prune exec/);
    assert.match(result.stdout, /deleted: 2 files/);
    await assert.rejects(fs.stat(body));
    await assert.rejects(fs.stat(log));
    await assert.doesNotReject(fs.stat(fresh));
    await assert.doesNotReject(fs.stat(unknown));
    await assert.doesNotReject(fs.stat(state));
  });

  it("--include-unknown allows explicit deletion of stale unknown files", async () => {
    const repo = await createRepo();
    const unknown = await writeFileWithAge(repo, "notes/tmp/mystery.bin", "?\n", 120);
    const freshUnknown = await writeFileWithAge(repo, "notes/tmp/fresh-mystery.bin", "?\n", 10);

    const result = run(repo, ["--include-unknown", "--exec", "--as-of", nowIso()]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /deleted: 1 files/);
    assert.match(result.stdout, /unknown skipped: 1 files/);
    await assert.rejects(fs.stat(unknown));
    await assert.doesNotReject(fs.stat(freshUnknown));
  });

  it("--max-age-minutes controls the stale cutoff", async () => {
    const repo = await createRepo();
    const log = await writeFileWithAge(repo, "notes/tmp/focused-test.log", "log\n", 30);

    const defaultRun = run(repo);
    assert.equal(defaultRun.status, 0, defaultRun.stderr);
    assert.match(defaultRun.stdout, /candidates: 0 files/);

    const shortRun = run(repo, ["--max-age-minutes", "10"]);
    assert.equal(shortRun.status, 0, shortRun.stderr);
    assert.match(shortRun.stdout, /candidates: 1 files/);
    await assert.doesNotReject(fs.stat(log));
  });

  it("bounds dry-run file listings by default and allows --limit 0 for full output", async () => {
    const repo = await createRepo();
    for (let i = 0; i < 55; i++) {
      await writeFileWithAge(repo, `notes/tmp/run-${String(i).padStart(2, "0")}.log`, "log\n", 120);
    }

    const bounded = run(repo);
    assert.equal(bounded.status, 0, bounded.stderr);
    assert.match(bounded.stdout, /candidates: 55 files/);
    assert.match(bounded.stdout, /list limit: 50/);
    assert.match(bounded.stdout, /\.\.\. 5 more not shown; use --limit 0 to list all/);
    assert.doesNotMatch(bounded.stdout, /run-54\.log/);

    const full = run(repo, ["--limit", "0"]);
    assert.equal(full.status, 0, full.stderr);
    assert.match(full.stdout, /list limit: all/);
    assert.match(full.stdout, /run-54\.log/);
  });

  it("dry-run prints its time point and a copyable --exec --as-of command", async () => {
    const repo = await createRepo();
    await writeFileWithAge(repo, "notes/tmp/test-output.log", "log\n", 120);

    const result = run(repo, ["--max-age-minutes", "30", "--include-unknown"]);

    assert.equal(result.status, 0, result.stderr);
    const asOf = result.stdout.match(/^as of: (\S+)$/m)?.[1];
    assert.ok(asOf && Number.isFinite(Date.parse(asOf)), result.stdout);
    assert.ok(
      result.stdout.includes(
        `node .devpro/scripts/prune-notes-tmp.mjs --exec --as-of ${asOf} --max-age-minutes 30 --include-unknown`
      ),
      result.stdout
    );
  });

  // [Scenario: branch-hygiene-tooling :: Exec Without A Dry-Run Time Is Refused]
  it("--exec without --as-of is refused and deletes nothing", async () => {
    const repo = await createRepo();
    const log = await writeFileWithAge(repo, "notes/tmp/test-output.log", "log\n", 120);

    const result = run(repo, ["--exec"]);

    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /--exec requires --as-of/);
    assert.match(result.stderr, /run the dry-run first/);
    await assert.doesNotReject(fs.stat(log));
  });

  // [Scenario: branch-hygiene-tooling :: Exec Deletes No More Than The Dry Run Listed]
  it("--exec --as-of keeps a file that went stale after the dry-run", async () => {
    const repo = await createRepo();
    // Both files exist before the dry-run time T; the late one is 0.5 s short of 60 minutes
    // at T and past 60 minutes by the time --exec runs.
    const asOfMs = Date.now() + 1_500;
    const old = await writeFileWithAge(repo, "notes/tmp/old-output.log", "log\n", 120);
    const lateStale = path.join(repo, "notes/tmp/late-output.log");
    await fs.writeFile(lateStale, "log\n");
    const lateMtime = new Date(asOfMs - 60 * 60_000 + 500);
    await fs.utimes(lateStale, lateMtime, lateMtime);
    await sleep(Math.max(0, asOfMs - Date.now()) + 1_000);

    const result = run(repo, ["--exec", "--as-of", new Date(asOfMs).toISOString()]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /deleted: 1 files/);
    await assert.rejects(fs.stat(old));
    await assert.doesNotReject(fs.stat(lateStale));
  });

  it("--exec --as-of keeps an old file moved into notes/tmp after the dry-run", async () => {
    const repo = await createRepo();
    const listed = await writeFileWithAge(repo, "notes/tmp/listed-output.log", "log\n", 120);
    const outside = await writeFileWithAge(repo, "moved-output.log", "log\n", 120);
    const dry = run(repo);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /candidates: 1 files/);
    const command = dry.stdout.match(/^ {2}(node \.devpro\/scripts\/prune-notes-tmp\.mjs --exec --as-of \S+.*)$/m)?.[1];
    assert.ok(command, dry.stdout);
    const moved = path.join(repo, "notes/tmp/moved-output.log");
    await fs.rename(outside, moved);

    const result = run(repo, command.split(" ").slice(2));

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /deleted: 1 files/);
    await assert.rejects(fs.stat(listed));
    await assert.doesNotReject(fs.stat(moved));
  });

  it("--exec --as-of keeps the files of a directory moved into notes/tmp after the dry-run", async () => {
    const repo = await createRepo();
    const listed = await writeFileWithAge(repo, "notes/tmp/kept-dir/listed-output.log", "log\n", 120);
    const outside = await writeFileWithAge(repo, "outside-dir/old-output.log", "log\n", 120);
    const dry = run(repo);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /candidates: 1 files/);
    const command = dry.stdout.match(/^ {2}(node \.devpro\/scripts\/prune-notes-tmp\.mjs --exec --as-of \S+.*)$/m)?.[1];
    assert.ok(command, dry.stdout);
    // Renaming a directory keeps its children's ctime; only the moved directory's ctime changes.
    await fs.rename(path.dirname(outside), path.join(repo, "notes/tmp/moved-dir"));

    const result = run(repo, command.split(" ").slice(2));

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /deleted: 1 files/);
    await assert.rejects(fs.stat(listed));
    await assert.doesNotReject(fs.stat(path.join(repo, "notes/tmp/moved-dir/old-output.log")));
  });

  it("--exec --as-of applies the same time point to cross-review attempts", {
    skip: plannerSkip,
  }, async () => {
    const repo = await createRepo();
    const attemptId = "attempt-stale-after-dry-run";
    const attempt = await createAttempt(repo, attemptId, { ageMinutes: 62 });
    const dryRunAt = new Date(Date.now() - 5 * 60_000).toISOString();

    const result = run(repo, ["--exec", "--as-of", dryRunAt]);

    assert.equal(result.status, 0, result.stderr);
    assertClassificationLine(result.stdout, attemptId, "ttl-skipped");
    assert.equal(await exists(attempt.root), true);
  });

  it("rejects an --as-of that is later than now or not an ISO time", async () => {
    const repo = await createRepo();
    const log = await writeFileWithAge(repo, "notes/tmp/test-output.log", "log\n", 120);

    const future = run(repo, ["--exec", "--as-of", new Date(Date.now() + 60 * 60_000).toISOString()]);
    assert.equal(future.status, 1, future.stdout);
    assert.match(future.stderr, /--as-of must not be later than now/);

    const malformed = run(repo, ["--exec", "--as-of", "yesterday"]);
    assert.equal(malformed.status, 1, malformed.stdout);
    assert.match(malformed.stderr, /--as-of requires an ISO 8601 UTC time/);

    // Date.parse would silently turn February 30 into March 2.
    const impossible = run(repo, ["--exec", "--as-of", "2026-02-30T08:30:00.000Z"]);
    assert.equal(impossible.status, 1, impossible.stdout);
    assert.match(impossible.stderr, /--as-of requires an ISO 8601 UTC time/);
    await assert.doesNotReject(fs.stat(log));

    const leapDay = run(repo, ["--as-of", "2024-02-29T08:30:00.000Z"]);
    assert.equal(leapDay.status, 0, leapDay.stderr);
    assert.match(leapDay.stdout, /^as of: 2024-02-29T08:30:00\.000Z$/m);
  });

  it("rejects --dry-run because no-argument mode is the dry-run contract", async () => {
    const repo = await createRepo();

    const result = run(repo, ["--dry-run"]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unsupported option: --dry-run/);
    assert.match(result.stderr, /Dry-run is the default no-argument mode/);
  });
});
