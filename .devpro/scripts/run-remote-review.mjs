#!/usr/bin/env node
/**
 * Remote review through the RunnerRelay target shell (OpenCode-only; see
 * .devpro/agent-rules/remote-review-gateway.md). Usage:
 *
 *   node .devpro/scripts/run-remote-review.mjs submit --repo-root <abs> --repo-id <id> \
 *     --role dp-reviewer|dp-second-reviewer --mode ordinary-primary|audit-only \
 *     --base <rev> --head <rev> [--scope-file <f>] [--criteria-file <f>] [--request-id <id>]
 *   node .devpro/scripts/run-remote-review.mjs status|cancel|purge --repo-root <abs> --request-id <id>
 *   node .devpro/scripts/run-remote-review.mjs result --repo-root <abs> --request-id <id> --out-dir <dir>
 *
 * Environment (the account and key live in the user's own ssh alias, never here):
 *   DEVPRO_REMOTE_REVIEW_BRIDGE_COMMAND  overrides the server's review-bridge.cmd (default) that status/result/cancel/purge run; submit does not use it
 *   DEVPRO_REMOTE_REVIEW_STAGING_PATH    remote staging directory, needed only for unpushed heads
 *   DEVPRO_REMOTE_REVIEW_SSH_ALIAS       default devpro-runnerrelay-demo
 *   DEVPRO_REMOTE_REVIEW_STATE_DIR       default <main checkout>/notes/tmp
 *
 * Prints one JSON line. Exit 0 = ok (result: finished, partial or completed); 1 = the review is
 * blocked or failed verification; 2 = usage, configuration or a refusal.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isAbsoluteCliPath, resolveCliPath } from "./lib/native-cli-path.mjs";
import {
  DEFAULT_BRIDGE_COMMAND,
  DEFAULT_SSH_ALIAS,
  RemoteReviewError,
  cancelRemoteReview,
  checkGatewayAlias,
  defaultRunProcess,
  fetchRemoteReview,
  mainCheckoutRoot,
  purgeRemoteReview,
  remoteReviewStatus,
  sshBridgeTransport,
  submitRemoteReview,
} from "./lib/remote-review-client.mjs";

const SUBMIT_FLAGS = ["--repo-root", "--repo-id", "--role", "--mode", "--base", "--head", "--scope-file", "--criteria-file", "--request-id", "--state-dir"];
const QUERY_FLAGS = ["--repo-root", "--request-id", "--state-dir", "--out-dir"];

function parseFlags(argv, allowed) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.includes(flag) || typeof value !== "string" || value === "" || Object.hasOwn(values, flag)) {
      throw new RemoteReviewError("usage", `unsupported or repeated argument ${JSON.stringify(flag)}`);
    }
    values[flag] = value;
  }
  return values;
}

function required(values, flags) {
  for (const flag of flags) {
    if (!Object.hasOwn(values, flag)) throw new RemoteReviewError("usage", `${flag} is required`);
  }
}

function absolute(value, flag) {
  // The drive spelling is mapped before the check and the resolution: `/c/work` is rooted but not yet a native Windows path.
  if (!isAbsoluteCliPath(value)) throw new RemoteReviewError("usage", `${flag} must be an absolute path`);
  return resolveCliPath(value);
}

export function runRemoteReviewCli(argv, { env = process.env, runProcess = defaultRunProcess, transport, runGit } = {}) {
  const [command, ...rest] = argv;
  if (!["submit", "status", "cancel", "purge", "result"].includes(command)) {
    throw new RemoteReviewError("usage", "command must be submit, status, cancel, purge or result");
  }
  const values = parseFlags(rest, command === "submit" ? SUBMIT_FLAGS : QUERY_FLAGS);
  required(values, command === "submit"
    ? ["--repo-root", "--repo-id", "--role", "--mode", "--base", "--head"]
    : ["--repo-root", "--request-id"].concat(command === "result" ? ["--out-dir"] : []));
  const repoRoot = absolute(values["--repo-root"], "--repo-root");
  const gitDeps = runGit ? { runGit } : {};
  const stateDir = values["--state-dir"] ?? env.DEVPRO_REMOTE_REVIEW_STATE_DIR
    ?? path.join(mainCheckoutRoot(repoRoot, runGit), "notes", "tmp");
  const alias = env.DEVPRO_REMOTE_REVIEW_SSH_ALIAS ?? DEFAULT_SSH_ALIAS;
  let activeTransport = transport;
  if (!activeTransport) {
    checkGatewayAlias({ alias, runProcess });
    activeTransport = sshBridgeTransport({
      alias,
      bridgeCommand: env.DEVPRO_REMOTE_REVIEW_BRIDGE_COMMAND ?? DEFAULT_BRIDGE_COMMAND,
      stagingRemotePath: env.DEVPRO_REMOTE_REVIEW_STAGING_PATH,
      runProcess,
    });
  }

  if (command === "submit") {
    const bundleDir = mkdtempSync(path.join(tmpdir(), "devpro-remote-review-"));
    try {
      return submitRemoteReview({
        repoRoot,
        repoId: values["--repo-id"],
        role: values["--role"],
        mode: values["--mode"],
        base: values["--base"],
        head: values["--head"],
        scope: values["--scope-file"] ? readFileSync(resolveCliPath(values["--scope-file"]), "utf8") : "",
        acceptanceCriteria: values["--criteria-file"] ? JSON.parse(readFileSync(resolveCliPath(values["--criteria-file"]), "utf8")) : [],
        ...(values["--request-id"] ? { requestId: values["--request-id"] } : {}),
        stateDir,
        bundleDir,
        transport: activeTransport,
        ...gitDeps,
      });
    } finally {
      rmSync(bundleDir, { recursive: true, force: true });
    }
  }
  const requestId = values["--request-id"];
  if (command === "status") return remoteReviewStatus({ requestId, stateDir, transport: activeTransport });
  if (command === "cancel") return cancelRemoteReview({ requestId, stateDir, transport: activeTransport });
  if (command === "purge") return purgeRemoteReview({ requestId, stateDir, transport: activeTransport });
  return fetchRemoteReview({
    requestId,
    repoRoot,
    stateDir,
    transport: activeTransport,
    outDir: absolute(values["--out-dir"], "--out-dir"),
    ...gitDeps,
  });
}

function directInvocation() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
}

if (directInvocation()) {
  try {
    const summary = runRemoteReviewCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    if (["failed", "blocked"].includes(summary.status)) process.exitCode = 1;
  } catch (error) {
    if (error instanceof RemoteReviewError) {
      process.stdout.write(`${JSON.stringify({ error: { code: error.code, message: error.detail, ...error.extra } })}\n`);
    } else {
      process.stderr.write(`${error.message}\n`);
    }
    process.exitCode = 2;
  }
}
