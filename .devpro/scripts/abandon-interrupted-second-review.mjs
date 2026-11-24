#!/usr/bin/env node
/** Operator disposition only: never observes/synthesizes process close or writes a review. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { isDirectCliInvocation } from "./lib/cli-entry.mjs";
import { attemptLockPath, lockOwnerState } from "./lib/second-review-attempt-lock.mjs";
import { controlEvidenceRoot, readDispatchEvidenceStrict, interruptedDispatchConfirmation,
  OPERATOR_DISPOSITION_SCHEMA, writeInterruptedDispatchDisposition } from "./hooks/lib/second-review-control-evidence.mjs";
import { listPostPrCompletionMarkers, withPostPrDispatchMarkerSnapshot } from "./hooks/lib/post-pr-completion-state.mjs";
import { parseSecondReviewStickyAuthorityBody, resolveSecondReviewStickyWriteDisposition,
  selectExactSecondReviewStickyAuthority } from "./hooks/lib/second-review-sticky-authority.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const identityFields = ["repository_slug", "pr_number", "head_ref_oid", "attempt_id", "dispatch_id", "previous_dispatch_id"];
function requireFact(condition, message) { if (!condition) throw new Error(message); }
function fileBytes(file, limit = 4 * 1024 * 1024) {
  const stat = lstatSync(file);
  requireFact(stat.isFile() && !stat.isSymbolicLink() && realpathSync(file) === path.resolve(file)
    && stat.size > 0 && stat.size <= limit, "operator evidence must be a bounded regular file at its canonical path");
  return readFileSync(file);
}
function command(binary, args, cwd) {
  return spawnSync(binary, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
}
function output(run, binary, args, cwd) {
  const result = run(binary, args, cwd);
  requireFact(result.status === 0 && !result.error, `${binary} evidence unavailable`);
  return String(result.stdout ?? "").trim();
}
function json(run, args, cwd) { return JSON.parse(output(run, "gh", args, cwd)); }

// Same ancestry test the renderer applies to the marker, so abandoning cannot succeed
// on a transition the fresh render would then refuse.
function assertHeadDescendsFromDispatch(dispatch, remoteHead, run, cwd) {
  if (remoteHead === dispatch.head_ref_oid) return;
  const ancestry = run("git", ["merge-base", "--is-ancestor", dispatch.head_ref_oid, remoteHead], cwd);
  requireFact(!ancestry.error && (ancestry.status === 0 || ancestry.status === 1),
    "cannot verify the PR head against the interrupted dispatch head; fetch the PR head and retry");
  requireFact(ancestry.status === 0, "PR head no longer descends from the interrupted dispatch head; rewritten history needs separate recovery");
}

// An earlier round's sticky carries that round's findings, not this attempt's, and abandoning leaves it in place.
function stickyPermitsAbandonment(disposition, comments, dispatch) {
  if (disposition.action === "create") return disposition.candidate_count === 0;
  if (disposition.action !== "update" || disposition.candidate_count !== 1) return false;
  const selected = selectExactSecondReviewStickyAuthority(comments);
  if (selected.status !== "selected") return false;
  const parsed = parseSecondReviewStickyAuthorityBody(selected.authority.body);
  return parsed.status === "valid" && Boolean(parsed.dispatch_id) && parsed.dispatch_id !== dispatch.dispatch_id;
}

function liveSnapshot(dispatch, run, cwd) {
  const repo = dispatch.repository_slug;
  const user = json(run, ["api", "user", "--jq", "{login: .login}"], cwd);
  const permission = json(run, ["api", `repos/${repo}`, "--jq", "{full_name: .full_name, permissions: .permissions}"], cwd);
  requireFact(typeof user.login === "string" && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(user.login), "authenticated operator login is invalid");
  requireFact(permission.full_name === repo && permission.permissions?.push === true, "authenticated operator lacks repository push permission");
  const pr = json(run, ["api", `repos/${repo}/pulls/${dispatch.pr_number}`, "--jq",
    "{number: .number, state: .state, merged_at: .merged_at, head: {sha: .head.sha, repo: {full_name: .head.repo.full_name}}, base: {repo: {full_name: .base.repo.full_name}}}"], cwd);
  const remoteHead = pr.head?.sha;
  requireFact(String(pr.number) === dispatch.pr_number && pr.state === "open" && pr.merged_at === null
    && /^[a-f0-9]{40}$/.test(String(remoteHead)) && pr.base?.repo?.full_name === repo
    && pr.head?.repo?.full_name === repo, "PR identity no longer matches the interrupted dispatch");
  assertHeadDescendsFromDispatch(dispatch, remoteHead, run, cwd);
  const pages = json(run, ["api", `repos/${repo}/issues/${dispatch.pr_number}/comments`, "--paginate", "--slurp"], cwd);
  requireFact(Array.isArray(pages) && pages.length > 0 && pages.length <= 30 && pages.every(Array.isArray), "sticky snapshot pagination is incomplete");
  const comments = pages.flat();
  const disposition = resolveSecondReviewStickyWriteDisposition({ repository_slug: repo, pr_number: Number(dispatch.pr_number),
    query_error: null, completeness: { status: "complete", pagination_exhausted: true, pages_fetched: pages.length }, comments });
  requireFact(stickyPermitsAbandonment(disposition, comments, dispatch), "operator abandonment requires zero canonical sticky comments or exactly one valid sticky bound to another dispatch; retain and resolve existing review authority separately");
  return { login: user.login, stickyDigest: disposition.snapshot_digest, remoteHead };
}

function interruptedSnapshot(contextPath, context, evidence, probeProcess) {
  const dispatch = evidence.dispatch;
  const dir = path.dirname(contextPath);
  const claimed = Boolean(evidence.invocationClaim);
  requireFact(dispatch && (claimed ? evidence.lifecycleSlot?.record?.kind === "runner_claimed" : !evidence.lifecycleSlot?.present)
    && !evidence.completion && !evidence.terminal && !evidence.capsule && !evidence.consumption
    && !evidence.supersession && !evidence.reviewerModelRecord, "interrupted attempt has an inconsistent claim or competing lifecycle authority");
  for (const field of identityFields) requireFact(context[field] === dispatch[field], `context ${field} does not match immutable dispatch`);
  requireFact(dispatch.carrier_root_id === digest(Buffer.from(dir)), "original carrier root binding mismatch");
  if (dispatch.paged_full_material_sha256) {
    requireFact(digest(fileBytes(path.join(dir, "paged-review-material-full.json"), 16 * 1024 * 1024)) === dispatch.paged_full_material_sha256,
      "original full material digest does not match immutable reservation");
  } else {
    requireFact(digest(fileBytes(path.join(dir, "packet.md"))) === dispatch.packet_sha256, "original packet digest does not match immutable reservation");
  }
  const activity = fileBytes(path.join(dir, "projection-activity.ndjson"));
  requireFact(activity.at(-1) === 10, "activity log has an incomplete invocation record");
  const rows = activity.toString("utf8").trimEnd().split("\n").map(line => JSON.parse(line));
  const claimRows = rows.filter(row => row.event === "projection_dispatch_invocation_claimed");
  const started = rows.filter(row => row.event === "projection_cli_started");
  const exited = rows.filter(row => row.event === "projection_cli_exited");
  if (claimed) {
    requireFact(claimRows.length === 1 && claimRows[0].dispatch_id === dispatch.dispatch_id
      && claimRows[0].attempt_id === dispatch.attempt_id && claimRows[0].invocation_claim_sha256 === digest(evidence.invocationClaimBytes),
      "claimed activity does not match the immutable invocation claim");
    // Equal counts mean the runner died between two page windows, with no reviewer left running.
    requireFact(started.length > 0 && [0, 1].includes(started.length - exited.length)
      && started.every(row => row.attempt_id === dispatch.attempt_id && Number.isSafeInteger(row.pid) && row.pid > 0)
      && exited.every(row => row.attempt_id === dispatch.attempt_id && row.process_close_observed === true),
      "activity does not prove an incomplete invocation");
  } else {
    requireFact(claimRows.length === 0 && started.length === 0 && exited.length === 0,
      "unclaimed attempt has reviewer activity; preserve it and investigate");
  }
  for (const row of started) {
    for (const pid of [row.pid, -row.pid]) {
      let absent = false;
      try { probeProcess(pid, 0); } catch (error) { absent = error?.code === "ESRCH"; }
      requireFact(absent, "reviewer PID/PGID is live or unverifiable; preserve the attempt");
    }
  }
  const lockPath = attemptLockPath(contextPath);
  requireFact(claimed || existsSync(lockPath),
    "this attempt never held a runner lock, so nothing is stuck; run its projection_runner_command, which closes it");
  const lockBytes = fileBytes(lockPath, 16 * 1024);
  const owner = lockOwnerState(lockPath, { signalOwner: pid => probeProcess(pid, 0) });
  requireFact(owner.state === "dead" && owner.owner?.attempt_id === dispatch.attempt_id, "runner lock owner is live or unverifiable");
  return { activity, lockBytes, claimed };
}

export async function runInterruptedAbandonment({ contextPath, cwd = process.cwd(), confirmation, reason,
  dryRun = false, runCommand = command, probeProcess = (pid, signal) => process.kill(pid, signal) } = {}) {
  const mainGitDir = output(runCommand, "git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
  const mainRoot = path.dirname(mainGitDir);
  const resolvedContext = path.resolve(mainRoot, contextPath);
  const context = JSON.parse(fileBytes(resolvedContext, 128 * 1024).toString("utf8"));
  requireFact(typeof context.attempt_id === "string" && /^[A-Za-z0-9._-]+$/.test(context.attempt_id)
    && resolvedContext === path.join(mainRoot, "notes", "cross-review", context.attempt_id, "observability-context.json"), "context must belong to this repository's canonical attempt carrier");
  const rootDir = controlEvidenceRoot(process.env, cwd);
  requireFact(context.control_evidence_root === rootDir, "context control-evidence root differs from the repository root");
  const evidence = readDispatchEvidenceStrict({ rootDir, dispatchId: context.dispatch_id });
  const dispatch = evidence.dispatch;
  requireFact(dispatch && (dryRun || confirmation === interruptedDispatchConfirmation(dispatch)),
    "pass the exact confirmation for this repository/PR/head/attempt/dispatch; --dry-run prints it");
  const origin = output(runCommand, "git", ["remote", "get-url", "origin"], cwd);
  const originMatch = origin.match(/^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+\/[^/]+?)(?:\.git)?$/);
  requireFact(originMatch?.[1] === dispatch.repository_slug, "local origin differs from the disposition target repository");
  const candidates = listPostPrCompletionMarkers(cwd, Date.now(), { pruneStale: false });
  requireFact(!candidates.some(marker => marker.marker_unreadable), "post-PR marker inventory is unreadable");
  const markers = candidates.filter(marker => String(marker.prNumber) === dispatch.pr_number && marker.repository_slug === dispatch.repository_slug);
  requireFact(markers.length === 1, "operator disposition requires one existing exact-bound post-PR marker");
  // The dry run follows the same locked validation path and performs no publication.
  return withPostPrDispatchMarkerSnapshot({ markerFile: markers[0].file, repositorySlug: dispatch.repository_slug,
    prNumber: dispatch.pr_number, headRefOid: dispatch.head_ref_oid, expectedDispatchId: dispatch.dispatch_id }, async ({ bytes: markerBytes }) => {
    const initial = interruptedSnapshot(resolvedContext, context, evidence, probeProcess);
    const live = liveSnapshot(dispatch, runCommand, cwd);
    const current = readDispatchEvidenceStrict({ rootDir, dispatchId: dispatch.dispatch_id });
    const final = interruptedSnapshot(resolvedContext, context, current, probeProcess);
    requireFact(initial.activity.equals(final.activity) && initial.lockBytes.equals(final.lockBytes), "attempt activity or owner changed while validating operator disposition");
    if (dryRun) return { status: "eligible", dispatch_id: dispatch.dispatch_id, confirmation: interruptedDispatchConfirmation(dispatch),
      next_step: "get the user's explicit decision to abandon this attempt, then rerun without --dry-run adding --confirm <confirmation> --reason <the user's statement>" };
    if (current.operatorDisposition) {
      requireFact(current.operatorDisposition.typed_confirmation === confirmation && current.operatorDisposition.reason === reason
        && current.operatorDisposition.operator_login === live.login
        && digest(final.activity.subarray(0, current.operatorDisposition.activity_prefix_length)) === current.operatorDisposition.activity_prefix_sha256,
        "existing immutable operator disposition does not match this retry");
      return { status: "idempotent", dispatch_id: dispatch.dispatch_id, record: current.operatorDisposition };
    }
    const checkedAt = new Date().toISOString();
    const record = { schema: OPERATOR_DISPOSITION_SCHEMA, ...Object.fromEntries(identityFields.map(field => [field, dispatch[field]])),
      outcome: "operator_abandoned_interrupted_dispatch", dispatch_sha256: digest(current.dispatchBytes),
      invocation_claim_sha256: final.claimed ? digest(current.invocationClaimBytes) : null,
      lifecycle_slot_sha256: final.claimed ? digest(fileBytes(current.paths.lifecycleSlot, 8192)) : null,
      packet_sha256: dispatch.packet_sha256, carrier_root_id: dispatch.carrier_root_id,
      paged_full_material_sha256: dispatch.paged_full_material_sha256 ?? null,
      activity_prefix_bytes: final.activity, activity_prefix_length: final.activity.length, activity_prefix_sha256: digest(final.activity),
      lock_snapshot_sha256: digest(final.lockBytes), marker_snapshot_sha256: digest(markerBytes), sticky_snapshot_sha256: live.stickyDigest,
      operator_login: live.login, repository_permissions_push: true, permission_source: "gh-api-repository", authorization_checked_at: checkedAt,
      pr_state: "OPEN", pr_merged: false, remote_pr_head: live.remoteHead, typed_confirmation: confirmation, reason, created_at: checkedAt,
      process_spawned: final.claimed, process_close_observed: false, transport_cleanup_confirmed: false, scan_complete: false,
      review_authority: "none", successor_policy: "fresh-full-review-only" };
    return writeInterruptedDispatchDisposition({ rootDir, record });
  });
}

if (isDirectCliInvocation(import.meta.url)) {
  const [contextPath, ...flags] = process.argv.slice(2);
  const options = { contextPath };
  try {
    for (let i = 0; i < flags.length; i++) {
      if (flags[i] === "--dry-run") options.dryRun = true;
      else if (flags[i] === "--confirm" || flags[i] === "--reason") options[flags[i].slice(2) === "confirm" ? "confirmation" : "reason"] = flags[++i];
      else throw new Error("usage: abandon-interrupted-second-review.mjs <context> --dry-run | <context> --confirm <exact challenge> --reason <operator statement>");
    }
    runInterruptedAbandonment(options).then(result => process.stdout.write(`${JSON.stringify(result)}\n`))
      .catch(error => { process.stderr.write(`${JSON.stringify({ status: "blocked", classification: "operator_disposition_precondition_failed", message: error.message })}\n`); process.exitCode = 1; });
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
