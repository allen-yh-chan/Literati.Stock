import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  controlEvidenceRoot,
  PR_2927_UNSTARTED_CONFIRMATION,
  PR_2927_UNSTARTED_DISPATCH,
  writeOperatorAbandonmentClosure,
} from "./hooks/lib/second-review-control-evidence.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "../..");

// Only implementation carriers governed by this one-time recovery must be
// clean. Other user-owned or untracked files, including openspec/config.yaml,
// are outside this exact bounded set and are never read or changed here.
export const IN_SCOPE_IMPLEMENTATION_CARRIERS = Object.freeze([
  ".devpro/scripts/abandon-pr-2927-unstarted-second-review.mjs",
  ".devpro/scripts/hooks/lib/second-review-control-evidence.mjs",
  ".devpro/scripts/hooks/lib/post-pr-completion-state.mjs",
  ".devpro/scripts/hooks/post-pr-completion-check.mjs",
  ".devpro/scripts/render-second-review-packet.mjs",
  ".devpro/scripts/test-suite-manifest.mjs",
  ".devpro/scripts/tests/abandon-pr-2927-unstarted-second-review.test.mjs",
  ".devpro/scripts/tests/second-review-control-evidence.test.mjs",
  ".devpro/scripts/tests/render-second-review-packet.test.mjs",
  ".devpro/scripts/tests/second-reviewer-projection-contract.test.mjs",
  ".devpro/scripts/tests/hook-post-pr-completion.test.mjs",
  ".devpro/agent-rules/second-review-control-evidence.md",
  ".devpro/agent-skills/devpro-reviews/second-review/SKILL.md",
  "openspec/changes/archive/2026-10-01-fix-post-pr-marker-non-ff-rebind/tasks.md",
  "openspec/changes/archive/2026-10-01-fix-post-pr-marker-non-ff-rebind/qa-test-scope.md",
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
  if (result?.status !== 0 || result.error) {
    throw new Error(`${label} could not be verified`);
  }
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
    /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i
  );
  return match ? `${match[1]}/${match[2]}` : null;
}

function requirePositiveIdentity(condition, message) {
  if (!condition) throw new Error(message);
}

function readGitValue(runCommand, args, cwd, label) {
  return requireCommand(runCommand("git", args, cwd), label);
}

function validateConfirmation(argv) {
  if (!Array.isArray(argv)
    || argv.length !== 2
    || argv[0] !== "--confirm"
    || argv[1] !== PR_2927_UNSTARTED_CONFIRMATION) {
    throw new Error("pass the exact PR #2927 dispatch/head runner_not_started confirmation");
  }
  return argv[1];
}

export async function runAbandonment({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  controlEvidenceRootDir = controlEvidenceRoot(process.env, cwd),
  runCommand = runProcess,
  writeClosure = writeOperatorAbandonmentClosure,
  now = () => new Date(),
} = {}) {
  const confirmation = validateConfirmation(argv);
  const localRoot = readGitValue(runCommand, ["rev-parse", "--show-toplevel"], cwd, "local repository root");
  requirePositiveIdentity(path.resolve(localRoot) === REPOSITORY_ROOT, "run this command from the exact PR #2927 source worktree");

  const localRepository = repositoryFromOrigin(
    readGitValue(runCommand, ["remote", "get-url", "origin"], cwd, "local origin repository")
  );
  requirePositiveIdentity(
    localRepository === PR_2927_UNSTARTED_DISPATCH.source_repository,
    "local origin does not match the allowlisted PR #2927 source repository",
  );
  const localBranch = readGitValue(runCommand, ["branch", "--show-current"], cwd, "local source branch");
  requirePositiveIdentity(localBranch === PR_2927_UNSTARTED_DISPATCH.source_ref, "local branch does not match the allowlisted PR #2927 source ref");
  const localImplementationCommit = readGitValue(runCommand, ["rev-parse", "HEAD"], cwd, "local implementation commit");
  requirePositiveIdentity(/^[a-f0-9]{40}$/.test(localImplementationCommit), "local implementation commit is not a full canonical SHA");

  const dirtyInScope = requireCommand(
    runCommand("git", ["status", "--porcelain", "--untracked-files=all", "--", ...IN_SCOPE_IMPLEMENTATION_CARRIERS], cwd),
    "in-scope implementation commit state",
  );
  requirePositiveIdentity(dirtyInScope.length === 0, "commit every in-scope PR #2927 recovery carrier before using this command");

  const user = requireJson(runCommand("gh", ["api", "user"], cwd), "authenticated GitHub login");
  requirePositiveIdentity(
    typeof user.login === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(user.login),
    "authenticated GitHub login is missing or invalid",
  );
  const repository = requireJson(
    runCommand("gh", ["api", `repos/${PR_2927_UNSTARTED_DISPATCH.repository_slug}`], cwd),
    "GitHub repository push permission",
  );
  requirePositiveIdentity(repository.permissions?.push === true, "authenticated account lacks repository push permission");

  const pr = requireJson(runCommand("gh", [
    "pr",
    "view",
    PR_2927_UNSTARTED_DISPATCH.pr_number,
    "--repo",
    PR_2927_UNSTARTED_DISPATCH.repository_slug,
    "--json",
    "number,state,mergedAt,baseRepository,headRepository,headRefName,headRefOid",
  ], cwd), "GitHub PR #2927 identity and head");
  const baseRepository = pr.baseRepository?.nameWithOwner;
  const headRepository = pr.headRepository?.nameWithOwner;
  requirePositiveIdentity(
    pr.number === Number(PR_2927_UNSTARTED_DISPATCH.pr_number)
      && pr.state === "OPEN"
      && pr.mergedAt === null
      && baseRepository === PR_2927_UNSTARTED_DISPATCH.repository_slug
      && headRepository === PR_2927_UNSTARTED_DISPATCH.source_repository
      && pr.headRefName === PR_2927_UNSTARTED_DISPATCH.source_ref
      && pr.headRefOid === PR_2927_UNSTARTED_DISPATCH.head_ref_oid,
    "GitHub PR #2927 is closed, merged, or no longer matches the exact reserved source/head tuple",
  );

  const authorization = {
    operator_login: user.login,
    repository_permissions_push: repository.permissions.push,
    permission_source: "gh-api-repository",
    target_repository: PR_2927_UNSTARTED_DISPATCH.repository_slug,
    pr_number: String(pr.number),
    pr_state: pr.state,
    pr_merged: pr.mergedAt !== null,
    base_repository: baseRepository,
    head_repository: headRepository,
    head_ref: pr.headRefName,
    remote_pr_head: pr.headRefOid,
    local_repository: localRepository,
    local_branch: localBranch,
    local_implementation_commit: localImplementationCommit,
    authorization_checked_at: now().toISOString(),
  };
  const closure = await writeClosure({
    rootDir: controlEvidenceRootDir,
    dispatchId: PR_2927_UNSTARTED_DISPATCH.dispatch_id,
    authorization,
    confirmation,
  });
  return {
    status: closure.status,
    dispatch_id: PR_2927_UNSTARTED_DISPATCH.dispatch_id,
    head_ref_oid: PR_2927_UNSTARTED_DISPATCH.head_ref_oid,
    operator_login: user.login,
    terminal_classification: closure.record?.classification ?? null,
  };
}

if (path.resolve(process.argv[1] ?? "") === SCRIPT_PATH) {
  runAbandonment()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      const response = {
        status: "blocked",
        classification: error?.classification ?? "operator_abandonment_precondition_failed",
        message: String(error?.message ?? "operator abandonment precondition failed").slice(0, 256),
      };
      process.stderr.write(`${JSON.stringify(response)}\n`);
      process.exitCode = 1;
    });
}
