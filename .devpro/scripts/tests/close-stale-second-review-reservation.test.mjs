import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { repoPath } from "./lib/repo-root.mjs";
import { makeTempDir } from "./lib/tmp.mjs";

const scriptPath = repoPath(".devpro/scripts/close-stale-second-review-reservation.mjs");
const helperPath = repoPath(".devpro/scripts/hooks/lib/second-review-control-evidence.mjs");
const SOURCE_SHA = "c".repeat(40);
const CURRENT_SHA = "d".repeat(40);
const TARGET = {
  repository_slug: "devpro-tw/devpro-agent-rules",
  pr_number: "2927",
  source_repository: "devpro-tw/devpro-agent-rules",
  source_ref: "bugfix/fix-post-pr-marker-non-ff-rebind",
  head_ref_oid: "1ca5d65c55dcb15f5395c201d413ce4a164ef327",
  attempt_id: "second-review-pr-2927-1ca5d65c55dc-initial-56293eef-eb39-4583-93bc-d20a75e8c846",
  dispatch_id: "dispatch-791fa840-4c9a-41f5-b376-93bfd20ad602",
  previous_dispatch_id: "dispatch-79f1b681-bca6-41c8-bd79-e129b1458be3",
};

function dispatchRecord() {
  return {
    schema: "devpro-second-review-dispatch/v1",
    repository_slug: TARGET.repository_slug,
    pr_number: TARGET.pr_number,
    head_ref_oid: TARGET.head_ref_oid,
    attempt_id: TARGET.attempt_id,
    dispatch_id: TARGET.dispatch_id,
    previous_dispatch_id: TARGET.previous_dispatch_id,
    packet_sha256: "a".repeat(64),
    carrier_root_id: "b".repeat(64),
    paged_full_material_sha256: "c".repeat(64),
    paged_full_material_created_at: "2026-09-30T09:47:51.779Z",
    paged_full_material_expires_at: "2026-09-30T11:47:51.779Z",
  };
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

async function fixture({ headRefOid = SOURCE_SHA, prHeadRefOid = headRefOid, activityEvents = null } = {}) {
  const rootDir = makeTempDir("stale-dispatch-control-evidence-");
  const mainCheckoutRoot = makeTempDir("stale-dispatch-shared-state-");
  const record = dispatchRecord();
  const evidenceDir = path.join(rootDir, record.dispatch_id);
  mkdirSync(evidenceDir, { recursive: true });
  writeJson(path.join(evidenceDir, "dispatch.json"), record);
  const attemptDirectory = path.join(mainCheckoutRoot, "notes", "cross-review", record.attempt_id);
  const contextPath = path.join(attemptDirectory, "observability-context.json");
  const paths = {
    heartbeat_path: path.join(attemptDirectory, "heartbeat.json"),
    activity_log_path: path.join(attemptDirectory, "projection-activity.ndjson"),
    cli_probe_result_path: path.join(attemptDirectory, "cli-probe-result.json"),
    stdout_log_path: path.join(attemptDirectory, "reviewer-stdout.ndjson"),
    stderr_log_path: path.join(attemptDirectory, "reviewer-stderr.log"),
  };
  const context = {
    attempt_id: record.attempt_id,
    dispatch_id: record.dispatch_id,
    previous_dispatch_id: record.previous_dispatch_id,
    mode: "pr-sticky",
    pr_number: record.pr_number,
    head_ref_oid: record.head_ref_oid,
    repository_slug: record.repository_slug,
    context_path: contextPath,
    observability_context_path: contextPath,
    control_evidence_root: rootDir,
    projection_runner_script: ".devpro/scripts/run-second-reviewer-projection.mjs",
    projection_runner_command: { argv: [repoPath(".devpro/scripts/run-second-reviewer-projection.mjs"), contextPath] },
    ...paths,
  };
  writeJson(contextPath, context);
  writeJson(paths.heartbeat_path, {
    status: "packet_rendered",
    attempt_id: record.attempt_id,
    dispatch_id: record.dispatch_id,
    generated_at: "2026-09-30T09:47:51.896Z",
  });
  writeJson(paths.cli_probe_result_path, {
    status: "pending",
    attempt_id: record.attempt_id,
    dispatch_id: record.dispatch_id,
    generated_at: "2026-09-30T09:47:51.896Z",
  });
  const activity = activityEvents ?? [{
    event: "packet_rendered",
    attempt_id: record.attempt_id,
    dispatch_id: record.dispatch_id,
    generated_at: "2026-09-30T09:47:51.896Z",
    reviewer_surface: "host-non-sandbox-required",
    runner_owner: "adapter-host-runner",
    packet_renderer: true,
  }];
  writeFileSync(paths.activity_log_path, `${activity.map((event) => JSON.stringify(event)).join("\n")}\n`);
  writeFileSync(paths.stdout_log_path, "");
  writeFileSync(paths.stderr_log_path, "");

  const calls = [];
  const runCommand = (binary, args, cwd) => {
    calls.push([binary, args, cwd]);
    if (binary === "git") {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { status: 0, stdout: repoPath("."), stderr: "" };
      if (args[0] === "remote") return { status: 0, stdout: "git@github.com:devpro-tw/devpro-agent-rules.git", stderr: "" };
      if (args[0] === "branch") return { status: 0, stdout: TARGET.source_ref, stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "HEAD") return { status: 0, stdout: headRefOid, stderr: "" };
      if (args[0] === "status") return { status: 0, stdout: "", stderr: "" };
    }
    if (binary === "gh" && args[0] === "api" && args[1] === "user") {
      return { status: 0, stdout: JSON.stringify({ login: "allenchan" }), stderr: "" };
    }
    if (binary === "gh" && args[0] === "api" && args[1] === `repos/${TARGET.repository_slug}`) {
      return { status: 0, stdout: JSON.stringify({ permissions: { push: true } }), stderr: "" };
    }
    if (binary === "gh" && args[0] === "api" && args[1] === `repos/${TARGET.repository_slug}/pulls/${TARGET.pr_number}`) {
      return { status: 0, stdout: JSON.stringify({
        number: 2927,
        state: "OPEN",
        mergedAt: null,
        baseRepository: TARGET.repository_slug,
        baseRefName: "main",
        headRepository: TARGET.source_repository,
        headRefName: TARGET.source_ref,
        headRefOid: prHeadRefOid,
      }), stderr: "" };
    }
    return { status: 1, stdout: "", stderr: "unexpected command" };
  };
  return {
    rootDir,
    mainCheckoutRoot,
    record,
    contextPath,
    paths,
    calls,
    runCommand,
    cleanup() {
      rmSync(rootDir, { recursive: true, force: true });
      rmSync(mainCheckoutRoot, { recursive: true, force: true });
    },
  };
}

async function loadScript() {
  assert.equal(existsSync(scriptPath), true);
  return import(`${pathToFileURL(scriptPath).href}?test=${Date.now()}`);
}

test("Scenario: Stale recovery is limited to the exact moved-head PR — CLI binds repo/PR/dispatch, live identity, pushed head, sidecar, and TTY challenge", async () => {
  const api = await loadScript();
  const state = await fixture();
  try {
    let captured = null;
    const result = await api.runStaleReservationClosure({
      argv: ["--repo", TARGET.repository_slug, "--pr", TARGET.pr_number, "--dispatch", TARGET.dispatch_id],
      cwd: repoPath("."),
      controlEvidenceRootDir: state.rootDir,
      mainCheckoutRoot: state.mainCheckoutRoot,
      runCommand: state.runCommand,
      isInteractiveTTY: () => true,
      confirmChallenge: async (challenge) => challenge,
      now: () => new Date("2026-10-01T03:00:00.000Z"),
      writeClosure: async (input) => {
        captured = input;
        return {
          status: "closed-stale-reservation-before-invocation",
          resumed: false,
          record: { classification: "stale_reservation_closed_pre_spawn", head_ref_oid: TARGET.head_ref_oid },
        };
      },
    });
    const helper = await import(`${pathToFileURL(helperPath).href}?challenge=${Date.now()}`);
    assert.equal(captured.authorization.operator_login, "allenchan");
    assert.equal(captured.authorization.repository_permissions_push, true);
    assert.equal(captured.authorization.observed_head_ref_oid, SOURCE_SHA);
    assert.equal(captured.authorization.confirmation_source, "interactive-tty");
    assert.equal(captured.confirmation, helper.staleReservationConfirmationChallenge(state.record, SOURCE_SHA));
    assert.equal(result.terminal_classification, "stale_reservation_closed_pre_spawn");
    assert.match(result.next_action, /fresh packet/);
    assert.equal(state.calls.some(([binary, args]) => binary === "gh"
      && args[0] === "api"
      && args[1] === `repos/${TARGET.repository_slug}/pulls/${TARGET.pr_number}`
      && args.includes("--jq")), true);
  } finally {
    state.cleanup();
  }
});

test("Scenario: Ambiguous authorization or runner evidence refuses before writing — CLI rejects non-TTY, unchanged head, unpushed implementation, and unknown activity", async () => {
  const api = await loadScript();
  for (const scenario of [
    { name: "non-TTY", isInteractiveTTY: () => false },
    { name: "same head", headRefOid: TARGET.head_ref_oid },
    { name: "unpushed local implementation", prHeadRefOid: "e".repeat(40), localHead: SOURCE_SHA },
    { name: "invalid packet-renderer marker", activityEvents: [{
      event: "packet_rendered",
      attempt_id: TARGET.attempt_id,
      dispatch_id: TARGET.dispatch_id,
      generated_at: "2026-09-30T09:47:51.896Z",
      reviewer_surface: "host-non-sandbox-required",
      runner_owner: "adapter-host-runner",
      packet_renderer: false,
    }] },
    { name: "unknown activity", activityEvents: [
      { event: "packet_rendered", attempt_id: TARGET.attempt_id, dispatch_id: TARGET.dispatch_id, generated_at: "2026-09-30T09:47:51.896Z", reviewer_surface: "host-non-sandbox-required", runner_owner: "adapter-host-runner" },
      { event: "projection_cli_started", attempt_id: TARGET.attempt_id, dispatch_id: TARGET.dispatch_id },
    ] },
  ]) {
    const state = await fixture({
      headRefOid: scenario.localHead ?? SOURCE_SHA,
      prHeadRefOid: scenario.prHeadRefOid ?? scenario.headRefOid ?? SOURCE_SHA,
      activityEvents: scenario.activityEvents,
    });
    try {
      let writes = 0;
      await assert.rejects(api.runStaleReservationClosure({
        argv: ["--repo", TARGET.repository_slug, "--pr", TARGET.pr_number, "--dispatch", TARGET.dispatch_id],
        cwd: repoPath("."),
        controlEvidenceRootDir: state.rootDir,
        mainCheckoutRoot: state.mainCheckoutRoot,
        runCommand: state.runCommand,
        isInteractiveTTY: scenario.isInteractiveTTY ?? (() => true),
        confirmChallenge: async (challenge) => challenge,
        writeClosure: async () => { writes += 1; throw new Error("must not close"); },
      }), undefined, scenario.name);
      assert.equal(writes, 0, scenario.name);
    } finally {
      state.cleanup();
    }
  }
});

test("stale-reservation CLI resumes from the immutable slot without querying GitHub or asking again", async () => {
  const api = await loadScript();
  const state = await fixture();
  try {
    const helper = await import(`${pathToFileURL(helperPath).href}?seed=${Date.now()}`);
    const authorization = {
      operator_login: "allenchan",
      repository_permissions_push: true,
      permission_source: "gh-api-repository",
      target_repository: TARGET.repository_slug,
      pr_number: TARGET.pr_number,
      pr_state: "OPEN",
      pr_merged: false,
      base_repository: TARGET.repository_slug,
      base_ref: "main",
      head_repository: TARGET.source_repository,
      head_ref: TARGET.source_ref,
      reserved_head_ref_oid: TARGET.head_ref_oid,
      observed_head_ref_oid: SOURCE_SHA,
      confirmation_source: "interactive-tty",
      authorization_checked_at: "2026-10-01T03:00:00.000Z",
    };
    await helper.writeStaleReservationClosure({
      rootDir: state.rootDir,
      dispatchId: TARGET.dispatch_id,
      authorization,
      confirmation: helper.staleReservationConfirmationChallenge(state.record, SOURCE_SHA),
    });
    state.calls.length = 0;
    const result = await api.runStaleReservationClosure({
      argv: ["--repo", TARGET.repository_slug, "--pr", TARGET.pr_number, "--dispatch", TARGET.dispatch_id],
      cwd: repoPath("."),
      controlEvidenceRootDir: state.rootDir,
      mainCheckoutRoot: state.mainCheckoutRoot,
      runCommand: state.runCommand,
      isInteractiveTTY: () => false,
    });
    assert.equal(result.resumed_from_slot, true);
    assert.equal(result.terminal_classification, "stale_reservation_closed_pre_spawn");
    assert.equal(state.calls.length, 0);
  } finally {
    state.cleanup();
  }
});

test("in-scope implementation carriers are tracked paths git can see, not paths behind a symlink", async () => {
  const { IN_SCOPE_IMPLEMENTATION_CARRIERS } = await import(pathToFileURL(scriptPath).href);
  // `git status -- <path>` reports nothing for a path that goes through a symlinked directory
  // (for example `.agents/skills/devpro`), so a dirty carrier listed that way would pass the
  // clean-tree precheck unseen.
  for (const carrier of IN_SCOPE_IMPLEMENTATION_CARRIERS) {
    const tracked = spawnSync("git", ["ls-files", "--error-unmatch", "--", carrier], { cwd: repoPath("."), encoding: "utf8" });
    assert.equal(tracked.status, 0, `${carrier} must be a tracked path, not one behind a symlink`);
  }
  assert.ok(
    IN_SCOPE_IMPLEMENTATION_CARRIERS.includes(".devpro/agent-skills/devpro-reviews/second-review/SKILL.md"),
    "the second-review SKILL.md this recovery changes must be covered by the clean-tree precheck",
  );
});
