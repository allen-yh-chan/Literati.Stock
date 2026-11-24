import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  controlEvidenceRoot,
  PR_2927_UNSTARTED_DISPATCH,
  readDispatchEvidence,
  staleReservationConfirmationChallenge,
  writeStaleReservationClosure,
} from "./hooks/lib/second-review-control-evidence.mjs";
import { resolveMainCheckoutRoot } from "./hooks/lib/repo-state-identity.mjs";
import { attemptLockPath } from "./lib/second-review-attempt-lock.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "../..");
const TARGET = PR_2927_UNSTARTED_DISPATCH;
const EXPECTED_EVENT_FIELDS = Object.freeze([
  "event",
  "attempt_id",
  "dispatch_id",
  "generated_at",
  "reviewer_surface",
  "runner_owner",
  "packet_renderer",
]);

export const IN_SCOPE_IMPLEMENTATION_CARRIERS = Object.freeze([
  ".devpro/scripts/close-stale-second-review-reservation.mjs",
  ".devpro/scripts/hooks/lib/second-review-control-evidence.mjs",
  ".devpro/scripts/lib/second-review-attempt-lock.mjs",
  ".devpro/scripts/tests/close-stale-second-review-reservation.test.mjs",
  ".devpro/scripts/tests/second-review-control-evidence.test.mjs",
  ".devpro/scripts/tests/second-review-completion-evidence-consumer-grep.test.mjs",
  ".devpro/scripts/tests/render-second-review-packet.test.mjs",
  ".devpro/scripts/test-suite-manifest.mjs",
  ".devpro/agent-rules/second-review-control-evidence.md",
  ".devpro/agent-skills/devpro-reviews/cross-review/SKILL.md",
  ".devpro/agent-skills/devpro-reviews/second-review/SKILL.md",
  "openspec/changes/archive/2026-10-01-fix-post-pr-marker-non-ff-rebind/brd.md",
  "openspec/changes/archive/2026-10-01-fix-post-pr-marker-non-ff-rebind/proposal.md",
  "openspec/changes/archive/2026-10-01-fix-post-pr-marker-non-ff-rebind/decisions.md",
  "openspec/changes/archive/2026-10-01-fix-post-pr-marker-non-ff-rebind/design.md",
  "openspec/changes/archive/2026-10-01-fix-post-pr-marker-non-ff-rebind/tasks.md",
  "openspec/changes/archive/2026-10-01-fix-post-pr-marker-non-ff-rebind/qa-test-scope.md",
  "openspec/changes/archive/2026-10-01-fix-post-pr-marker-non-ff-rebind/specs/cross-runtime-parity/spec.md",
  "openspec/specs/cross-runtime-parity/spec.md",
]);

function runProcess(binary, args, cwd) {
  const result = spawnSync(binary, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024,
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    error: result.error,
  };
}

function requireCommand(result, label) {
  if (result?.status !== 0 || result.error) throw new Error(`${label} could not be verified`);
  return String(result.stdout ?? "").trim();
}

function requireJson(result, label) {
  const output = requireCommand(result, label);
  try {
    const value = JSON.parse(output);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("shape");
    return value;
  } catch {
    throw new Error(`${label} returned unavailable or malformed evidence`);
  }
}

function repositoryFromOrigin(remoteUrl) {
  const match = String(remoteUrl ?? "").match(
    /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i,
  );
  return match ? `${match[1]}/${match[2]}` : null;
}

function parseTargetArguments(argv) {
  const expected = ["--repo", TARGET.repository_slug, "--pr", TARGET.pr_number, "--dispatch", TARGET.dispatch_id];
  if (!Array.isArray(argv) || argv.length !== expected.length
    || expected.some((value, index) => argv[index] !== value)) {
    throw new Error(`use the exact target: --repo ${TARGET.repository_slug} --pr ${TARGET.pr_number} --dispatch ${TARGET.dispatch_id}`);
  }
}

function readBoundedJson(filePath, label, maxBytes = 128 * 1024) {
  const size = statSync(filePath).size;
  if (size <= 0 || size > maxBytes) throw new Error(`${label} is empty or exceeds its evidence bound`);
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    throw new Error(`${label} is malformed or unreadable`);
  }
}

function assertAttemptEvidence({ mainCheckoutRoot, rootDir }) {
  const attemptDirectory = path.join(mainCheckoutRoot, "notes", "cross-review", TARGET.attempt_id);
  const contextPath = path.join(attemptDirectory, "observability-context.json");
  const context = readBoundedJson(contextPath, "old dispatch observability context", 512 * 1024);
  if (context.attempt_id !== TARGET.attempt_id
    || context.dispatch_id !== TARGET.dispatch_id
    || context.previous_dispatch_id !== TARGET.previous_dispatch_id
    || context.repository_slug !== TARGET.repository_slug
    || String(context.pr_number) !== TARGET.pr_number
    || context.head_ref_oid !== TARGET.head_ref_oid
    || path.resolve(String(context.control_evidence_root ?? "")) !== path.resolve(rootDir)
    || context.context_path !== contextPath
    || context.observability_context_path !== contextPath) {
    throw new Error("old dispatch context does not bind the exact reservation and shared evidence root");
  }
  const runnerPath = path.join(REPOSITORY_ROOT, ".devpro/scripts/run-second-reviewer-projection.mjs");
  if (context.projection_runner_script !== ".devpro/scripts/run-second-reviewer-projection.mjs"
    || path.resolve(String(context.projection_runner_command?.argv?.[0] ?? "")) !== runnerPath) {
    throw new Error("old dispatch context points at an unknown or different runner version");
  }
  if (existsSync(attemptLockPath(contextPath))) {
    throw new Error("old dispatch still has an attempt lock; live, dead, malformed, or unknown locks all block closure");
  }
  const expectedArtifacts = {
    heartbeat_path: path.join(attemptDirectory, "heartbeat.json"),
    activity_log_path: path.join(attemptDirectory, "projection-activity.ndjson"),
    cli_probe_result_path: path.join(attemptDirectory, "cli-probe-result.json"),
    stdout_log_path: path.join(attemptDirectory, "reviewer-stdout.ndjson"),
    stderr_log_path: path.join(attemptDirectory, "reviewer-stderr.log"),
  };
  for (const [field, expectedPath] of Object.entries(expectedArtifacts)) {
    if (path.resolve(String(context[field] ?? "")) !== expectedPath) {
      throw new Error(`old dispatch context ${field} points outside its exact attempt directory`);
    }
  }
  const heartbeat = readBoundedJson(expectedArtifacts.heartbeat_path, "old dispatch heartbeat");
  const probe = readBoundedJson(expectedArtifacts.cli_probe_result_path, "old dispatch CLI probe");
  for (const [label, artifact, expectedStatus] of [
    ["heartbeat", heartbeat, "packet_rendered"],
    ["CLI probe", probe, "pending"],
  ]) {
    if (artifact.status !== expectedStatus
      || artifact.attempt_id !== TARGET.attempt_id
      || artifact.dispatch_id !== TARGET.dispatch_id) {
      throw new Error(`${label} does not prove an unstarted exact dispatch`);
    }
  }
  const activityPath = expectedArtifacts.activity_log_path;
  const activityBytes = readFileSync(activityPath);
  if (activityBytes.length === 0 || activityBytes.length > 64 * 1024) {
    throw new Error("old dispatch activity evidence is empty or exceeds its evidence bound");
  }
  const activityLines = activityBytes.toString("utf8").trimEnd().split("\n");
  if (activityLines.length !== 1) throw new Error("old dispatch has unknown or additional runner activity");
  let event;
  try { event = JSON.parse(activityLines[0]); } catch {
    throw new Error("old dispatch activity evidence is malformed");
  }
  if (JSON.stringify(Object.keys(event).sort()) !== JSON.stringify([...EXPECTED_EVENT_FIELDS].sort())
    || event.event !== "packet_rendered"
    || event.attempt_id !== TARGET.attempt_id
    || event.dispatch_id !== TARGET.dispatch_id
    || event.packet_renderer !== true) {
    throw new Error("old dispatch activity is not the exact packet-rendered-only event");
  }
  for (const field of ["stdout_log_path", "stderr_log_path"]) {
    if (statSync(expectedArtifacts[field]).size !== 0) {
      throw new Error(`old dispatch ${field} is non-empty and indicates unclassified runner activity`);
    }
  }
  return { contextPath, context };
}

async function readInteractiveConfirmation(challenge) {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await terminal.question(`\nThis closes only the stale predecessor; it does not approve the PR.\nType exactly:\n${challenge}\n> `);
  } finally {
    terminal.close();
  }
}

function readGitValue(runCommand, args, cwd, label) {
  return requireCommand(runCommand("git", args, cwd), label);
}

export async function runStaleReservationClosure({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  controlEvidenceRootDir = controlEvidenceRoot(process.env, cwd),
  mainCheckoutRoot = resolveMainCheckoutRoot(cwd).mainCheckoutRoot,
  runCommand = runProcess,
  readEvidence = readDispatchEvidence,
  writeClosure = writeStaleReservationClosure,
  isInteractiveTTY = () => process.stdin.isTTY === true && process.stdout.isTTY === true,
  confirmChallenge = readInteractiveConfirmation,
  now = () => new Date(),
} = {}) {
  parseTargetArguments(argv);
  const evidence = readEvidence({ rootDir: controlEvidenceRootDir, dispatchId: TARGET.dispatch_id });
  if (!evidence.dispatch || evidence.dispatch.dispatch_id !== TARGET.dispatch_id) {
    throw new Error("the exact stale dispatch reservation is missing");
  }
  if (evidence.lifecycleSlot?.present) {
    if (evidence.lifecycleSlot.unparseable || !evidence.lifecycleSlot.record) {
      throw new Error("existing lifecycle slot is malformed or unreadable");
    }
    if (evidence.lifecycleSlot.record.kind !== "stale_reservation_closed") {
      throw new Error("runner already owns this lifecycle slot; stale closure is forbidden");
    }
    const closure = await writeClosure({ rootDir: controlEvidenceRootDir, dispatchId: TARGET.dispatch_id });
    return {
      status: closure.status,
      dispatch_id: TARGET.dispatch_id,
      observed_head_ref_oid: evidence.lifecycleSlot.record.observed_head_ref_oid,
      terminal_classification: closure.record?.classification ?? null,
      next_action: "render a fresh packet against the current PR head; the close itself creates no successor",
      resumed_from_slot: true,
    };
  }
  if (evidence.invocationClaim || evidence.completion || evidence.terminal || evidence.capsule
    || evidence.consumption || evidence.supersession || evidence.reviewerModelRecord
    || evidence.externalClosure?.present || evidence.operatorAbandonment?.present) {
    throw new Error("old dispatch has competing lifecycle evidence and cannot be classified as unstarted");
  }
  if (!isInteractiveTTY()) throw new Error("stale-reservation closure requires an interactive TTY for its operation-specific challenge");

  const localRoot = readGitValue(runCommand, ["rev-parse", "--show-toplevel"], cwd, "local repository root");
  if (path.resolve(localRoot) !== REPOSITORY_ROOT) throw new Error("run this command from the exact PR #2927 source worktree");
  const localRepository = repositoryFromOrigin(readGitValue(runCommand, ["remote", "get-url", "origin"], cwd, "local origin repository"));
  if (localRepository !== TARGET.source_repository) throw new Error("local origin does not match the PR #2927 source repository");
  const localBranch = readGitValue(runCommand, ["branch", "--show-current"], cwd, "local source branch");
  if (localBranch !== TARGET.source_ref) throw new Error("local branch does not match the PR #2927 source ref");
  const localCommit = readGitValue(runCommand, ["rev-parse", "HEAD"], cwd, "local implementation commit");
  if (!/^[a-f0-9]{40}$/.test(localCommit)) throw new Error("local implementation commit is not a full canonical SHA");
  const dirtyInScope = requireCommand(
    runCommand("git", ["status", "--porcelain", "--untracked-files=all", "--", ...IN_SCOPE_IMPLEMENTATION_CARRIERS], cwd),
    "in-scope implementation commit state",
  );
  if (dirtyInScope.length !== 0) throw new Error("commit all in-scope stale-reservation recovery carriers before closure");

  const user = requireJson(runCommand("gh", ["api", "user"], cwd), "authenticated GitHub login");
  if (typeof user.login !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(user.login)) {
    throw new Error("authenticated GitHub login is missing or invalid");
  }
  const repository = requireJson(runCommand("gh", ["api", `repos/${TARGET.repository_slug}`], cwd), "GitHub repository push permission");
  if (repository.permissions?.push !== true) throw new Error("authenticated account lacks repository push permission");
  const pr = requireJson(runCommand("gh", [
    "api", `repos/${TARGET.repository_slug}/pulls/${TARGET.pr_number}`,
    "--jq", "{number, state: (.state | ascii_upcase), mergedAt: .merged_at, baseRepository: .base.repo.full_name, baseRefName: .base.ref, headRepository: .head.repo.full_name, headRefName: .head.ref, headRefOid: .head.sha}",
  ], cwd), "GitHub PR #2927 identity and current head");
  const baseRepository = pr.baseRepository;
  const headRepository = pr.headRepository;
  if (pr.number !== Number(TARGET.pr_number)
    || pr.state !== "OPEN"
    || pr.mergedAt !== null
    || baseRepository !== TARGET.repository_slug
    || pr.baseRefName !== "main"
    || headRepository !== TARGET.source_repository
    || pr.headRefName !== TARGET.source_ref
    || !/^[a-f0-9]{40}$/.test(String(pr.headRefOid ?? ""))
    || pr.headRefOid === TARGET.head_ref_oid
    || pr.headRefOid !== localCommit) {
    throw new Error("GitHub PR is closed, merged, unchanged, or does not match the pushed local source head");
  }

  assertAttemptEvidence({ mainCheckoutRoot, rootDir: controlEvidenceRootDir });
  const authorization = {
    operator_login: user.login,
    repository_permissions_push: repository.permissions.push,
    permission_source: "gh-api-repository",
    target_repository: TARGET.repository_slug,
    pr_number: String(pr.number),
    pr_state: pr.state,
    pr_merged: pr.mergedAt !== null,
    base_repository: baseRepository,
    base_ref: pr.baseRefName,
    head_repository: headRepository,
    head_ref: pr.headRefName,
    reserved_head_ref_oid: evidence.dispatch.head_ref_oid,
    observed_head_ref_oid: pr.headRefOid,
    confirmation_source: "interactive-tty",
    authorization_checked_at: now().toISOString(),
  };
  const challenge = staleReservationConfirmationChallenge(evidence.dispatch, pr.headRefOid);
  const confirmation = await confirmChallenge(challenge);
  const closure = await writeClosure({
    rootDir: controlEvidenceRootDir,
    dispatchId: TARGET.dispatch_id,
    authorization,
    confirmation,
  });
  return {
    status: closure.status,
    dispatch_id: TARGET.dispatch_id,
    reserved_head_ref_oid: evidence.dispatch.head_ref_oid,
    observed_head_ref_oid: pr.headRefOid,
    operator_login: user.login,
    terminal_classification: closure.record?.classification ?? null,
    next_action: "render a fresh packet against the current PR head; the close itself creates no successor",
    resumed_from_slot: closure.resumed === true,
  };
}

if (path.resolve(process.argv[1] ?? "") === SCRIPT_PATH) {
  runStaleReservationClosure()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      const response = {
        status: "blocked",
        classification: error?.classification ?? "stale_reservation_closure_precondition_failed",
        message: String(error?.message ?? "stale-reservation closure precondition failed").slice(0, 256),
      };
      process.stderr.write(`${JSON.stringify(response)}\n`);
      process.exitCode = 1;
    });
}
