/**
 * remote-review-client.mjs
 *
 * Developer-side thin client for the remote review route (local repo -> RunnerRelay target
 * shell -> review bridge -> Hermes -> OpenCode). It freezes a committed target, ships either
 * nothing (already pushed) or a digest-checked Git bundle, talks to the bridge only through
 * an injected transport, and verifies everything that comes back before it hands a report to
 * the existing readers.
 *
 * Boundaries:
 * - the remote route is OpenCode-only; the client never probes or falls back to another CLI;
 * - Hermes' own text is never a verdict: only the bridge-verified worker files count;
 * - remote evidence is verified at its source and is NEVER re-minted as local sealed control
 *   evidence: receipts carry `sealed_admission: false`;
 * - pr-sticky is refused here: publishing a sticky needs a remote credential design that does
 *   not exist yet.
 *
 * Contract with the bridge (scripts/demo-security/review_bridge.py in devpro-hermes-plugins):
 * request/response JSON as documented in that repo's README. The reviewed target and the
 * dispatch the remote Guarantee Assessment must name are the head commit SHA and the
 * request id.
 */

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  readPrimaryReviewVerdict,
} from "./opencode-primary-review.mjs";
import { readReviewGuaranteeAssessment } from "../review-guarantee-assessment.mjs";

export const REMOTE_REVIEW_EXECUTOR = "remote-opencode";
export const REMOTE_REVIEWER_CLI = "opencode";
export const REMOTE_ROLE_MODES = Object.freeze({
  "dp-reviewer": Object.freeze(["ordinary-primary"]),
  "dp-second-reviewer": Object.freeze(["audit-only"]),
});
export const GATEWAY_HOST = "demo.devpro.com.tw";
export const GATEWAY_PORT = "20222";
export const DEFAULT_SSH_ALIAS = "devpro-runnerrelay-demo";
// The fixed entry the server administrator installs for status/result/cancel/purge (submit does not use it). It is a
// contract path, not an interpreter path: which Python runs the bridge is the wrapper's business, not this client's.
export const DEFAULT_BRIDGE_COMMAND = "C:\\ProgramData\\Devpro\\Hermes\\Home\\scripts\\remote-review\\review-bridge.cmd";
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$/u;
const REPO_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
const SHA1_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
// Submission goes through the Gateway's own verb, not the bridge command: the Gateway signs a proof for it, so the
// bridge can record who created the request. Exactly these three words, run without a PTY.
export const GATEWAY_REVIEW_SUBMIT_COMMAND = "hermes review submit";
// The opaque creator code the bridge returns (sha256 prefix of the Gateway issuer and principal, 16 hex).
const CREATOR_REF_PATTERN = /^[0-9a-f]{16}$/u;
const GATEWAY_ERROR_CODE_PATTERN = /^[a-z0-9_]{1,64}$/u;
const BRIDGE_COMMAND_PATTERN = /^[A-Za-z0-9 _.:\\/"-]{1,300}$/u;
const REMOTE_PATH_PATTERN = /^\/?[A-Za-z0-9 _.:\\/-]{1,300}$/u;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 8 * 1024 * 1024;
const REPORT_NAME = "report.md";

export class RemoteReviewError extends Error {
  constructor(code, message, extra = {}) {
    super(`${code}: ${message}`);
    this.name = "RemoteReviewError";
    this.code = code;
    this.detail = message;
    this.extra = extra;
  }
}

const refuse = (code, message, extra) => { throw new RemoteReviewError(code, message, extra); };

// The code is a label, not a credential: it is kept only in the exact shape the bridge produces. Anything else
// (including a missing key from a bridge that records no creator) is "no creator recorded", never an error.
const creatorRefOf = (value) => (typeof value === "string" && CREATOR_REF_PATTERN.test(value) ? value : null);
const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

// --------------------------------------------------------------------------- //
// Process helpers (injectable)
// --------------------------------------------------------------------------- //

export function defaultRunGit(args, { cwd }) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export function defaultRunProcess(file, args, { input, timeoutMs = 120000 } = {}) {
  const result = spawnSync(file, args, {
    input,
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: result.stdout ? result.stdout.toString("utf8") : "",
    stderr: result.stderr ? result.stderr.toString("utf8") : "",
    error_code: result.error?.code ?? null,
  };
}

function gitText(runGit, repoRoot, args, failCode) {
  const result = runGit(args, { cwd: repoRoot });
  if (result.status !== 0) refuse(failCode, `git ${args[0]} failed`);
  return result.stdout.trim();
}

function resolveCommit(runGit, repoRoot, revision, label) {
  if (typeof revision !== "string" || revision === "" || revision.startsWith("-")) {
    refuse("invalid_input", `${label} must be a commit-ish`);
  }
  const result = runGit(["rev-parse", "--verify", "--quiet", `${revision}^{commit}`], { cwd: repoRoot });
  const sha = result.stdout.trim();
  if (result.status !== 0 || !SHA1_PATTERN.test(sha)) refuse("target_unresolved", `${label} does not resolve to a SHA-1 commit`);
  return sha;
}

// --------------------------------------------------------------------------- //
// Target freezing, request and bundle
// --------------------------------------------------------------------------- //

export function newRequestId(random = randomBytes) {
  return `rr-${random(8).toString("hex")}`;
}

const MAX_SHALLOW_ROOT_CANDIDATES = 64;

/**
 * Root commits of the history reachable from the head. A shallow clone also reports its cut-off
 * commits as roots, although their commit objects still name parents; those are not roots of the
 * repository, so they are dropped and only commits with no parent line are kept.
 */
function repositoryRoots(runGit, repoRoot, headSha) {
  const candidates = gitText(runGit, repoRoot, ["rev-list", "--max-parents=0", headSha], "target_unresolved")
    .split(/\s+/u).filter(Boolean).sort();
  if (gitText(runGit, repoRoot, ["rev-parse", "--is-shallow-repository"], "target_unresolved") !== "true") return candidates;
  if (candidates.length > MAX_SHALLOW_ROOT_CANDIDATES || candidates.some((sha) => !SHA1_PATTERN.test(sha))) {
    refuse("target_unresolved", "the repository binding (root commits) could not be established");
  }
  const roots = candidates.filter((sha) => {
    const headers = gitText(runGit, repoRoot, ["cat-file", "commit", sha], "target_unresolved").split("\n\n")[0];
    return !/^parent /mu.test(headers);
  });
  if (roots.length === 0) {
    refuse("target_unresolved", "this clone is too shallow to show any real root commit, so the repository binding cannot be established; run git fetch --unshallow");
  }
  return roots;
}

/**
 * Freeze a committed base/head. Reviewed dirty changes are NOT-READY: nothing is stashed,
 * committed or dropped on the developer's behalf.
 */
export function freezeCommitTarget({ repoRoot, base, head, runGit = defaultRunGit }) {
  if (!path.isAbsolute(String(repoRoot ?? ""))) refuse("invalid_input", "repo root must be an absolute path");
  const dirty = runGit(["status", "--porcelain", "--untracked-files=no"], { cwd: repoRoot });
  if (dirty.status !== 0) refuse("target_unresolved", "git status failed");
  if (dirty.stdout.trim() !== "") {
    refuse("target_dirty", "tracked changes are not committed; commit them first (nothing was stashed or dropped)");
  }
  const baseSha = resolveCommit(runGit, repoRoot, base, "base");
  const headSha = resolveCommit(runGit, repoRoot, head, "head");
  const rootCommits = repositoryRoots(runGit, repoRoot, headSha);
  if (rootCommits.length === 0 || rootCommits.length > 16 || rootCommits.some((sha) => !SHA1_PATTERN.test(sha))) {
    refuse("target_unresolved", "the repository binding (root commits) could not be established");
  }
  const remoteBranches = runGit(["branch", "-r", "--contains", headSha], { cwd: repoRoot });
  const pushed = remoteBranches.status === 0 && remoteBranches.stdout.trim() !== "";
  return {
    base: baseSha,
    head: headSha,
    rootCommits,
    pushed,
    localHead: gitText(runGit, repoRoot, ["rev-parse", "HEAD"], "target_unresolved"),
  };
}

function bundleRef(runGit, repoRoot, headSha, localHead) {
  if (headSha === localHead) return "HEAD";
  const branches = runGit(["for-each-ref", "--points-at", headSha, "--format=%(refname)", "refs/heads"], { cwd: repoRoot });
  const first = branches.stdout.split("\n").map((line) => line.trim()).find(Boolean);
  if (!first) {
    refuse("head_not_bundlable", "the head is neither the checked-out commit nor a local branch tip; check it out or name a branch");
  }
  return first;
}

/** Create the bundle for an unpushed head (no ref is written in the developer's repository). */
export function createReviewBundle({ repoRoot, frozen, requestId, outDir, runGit = defaultRunGit }) {
  const ref = bundleRef(runGit, repoRoot, frozen.head, frozen.localHead);
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const file = path.join(outDir, `${requestId}.bundle`);
  const made = runGit(["bundle", "create", file, ref, `^${frozen.base}`], { cwd: repoRoot });
  if (made.status !== 0) refuse("bundle_failed", "git could not create the review bundle");
  const bytes = readFileSync(file);
  return { path: file, sha256: sha256Hex(bytes), bytes: bytes.length, ref };
}

export function assertRemoteRoleMode(role, mode) {
  if (mode === "pr-sticky") {
    refuse("mode_not_supported_remote", "pr-sticky is not available on the remote route: sticky publication has no remote credential design yet");
  }
  if (!REMOTE_ROLE_MODES[role]?.includes(mode)) refuse("mode_not_supported_remote", "unsupported role and mode combination for the remote route");
}

export function buildReviewRequest({ requestId, repoId, role, mode, frozen, bundle = null, scope = "", acceptanceCriteria = [] }) {
  if (!REQUEST_ID_PATTERN.test(requestId ?? "")) refuse("invalid_input", "request id has an unsupported shape");
  if (!REPO_ID_PATTERN.test(repoId ?? "")) refuse("invalid_input", "repo id has an unsupported shape");
  assertRemoteRoleMode(role, mode);
  if (typeof scope !== "string" || Buffer.byteLength(scope) > MAX_TEXT_BYTES
    || !Array.isArray(acceptanceCriteria) || acceptanceCriteria.some((item) => typeof item !== "string")
    || Buffer.byteLength(JSON.stringify(acceptanceCriteria)) > MAX_TEXT_BYTES) {
    refuse("invalid_input", "scope or acceptance criteria are invalid or too large");
  }
  return {
    schema: 1,
    request_id: requestId,
    repo_id: repoId,
    role,
    mode,
    target: { kind: "commits", base: frozen.base, head: frozen.head },
    repo_binding: { root_commits: frozen.rootCommits },
    bundle: bundle ? { sha256: bundle.sha256, bytes: bundle.bytes, ref: bundle.ref } : null,
    scope,
    acceptance_criteria: acceptanceCriteria,
  };
}

// --------------------------------------------------------------------------- //
// Local submission record (binds the answer back to this repository state)
// --------------------------------------------------------------------------- //

export function mainCheckoutRoot(repoRoot, runGit = defaultRunGit) {
  const common = runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: repoRoot });
  const dir = common.stdout.trim();
  if (common.status !== 0 || !path.isAbsolute(dir)) refuse("target_unresolved", "the main checkout could not be located");
  return path.dirname(dir);
}

export function recordPath(stateDir, requestId) {
  if (!REQUEST_ID_PATTERN.test(requestId ?? "")) refuse("invalid_input", "request id has an unsupported shape");
  return path.join(stateDir, `remote-review-${requestId}.json`);
}

function writeJsonAtomic(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
}

// Creates `file` only when nobody has yet, with its whole content visible at once: the content goes to a private temp
// file that is hard-linked into place, and the link fails with EEXIST when another process got there first. Returns
// whether this call created the file. (A plain "is there a record?" check followed by a write leaves a window in
// which two submissions of the same id both pass the check and the second replaces the first one's binding.)
function writeJsonExclusive(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  try {
    linkSync(temp, file);
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  } finally {
    rmSync(temp, { force: true });
  }
}

export function readRecord(stateDir, requestId) {
  const file = recordPath(stateDir, requestId);
  if (!existsSync(file)) refuse("local_record_missing", "no local record for this request; its binding to the repository cannot be proven");
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return refuse("local_record_missing", "the local record is unreadable");
  }
}

function readRecordIfPresent(stateDir, requestId) {
  const file = recordPath(stateDir, requestId);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return refuse("request_id_in_use", "a local record exists for this request id but cannot be read");
  }
}

// --------------------------------------------------------------------------- //
// Transport (ssh/scp through the user's own alias; injectable for tests)
// --------------------------------------------------------------------------- //

export function checkGatewayAlias({ alias, runProcess = defaultRunProcess }) {
  const result = runProcess("ssh", ["-G", alias], { timeoutMs: 15000 });
  const lines = new Map(result.stdout.split("\n").map((line) => {
    const [key, ...rest] = line.trim().split(/\s+/u);
    return [key, rest.join(" ")];
  }));
  if (result.status !== 0 || lines.get("hostname") !== GATEWAY_HOST || lines.get("port") !== GATEWAY_PORT) {
    refuse("gateway_alias_not_configured", `the ssh alias ${alias} does not point at the gateway; see remote-review-gateway.md`);
  }
}

export function sshBridgeTransport({ alias = DEFAULT_SSH_ALIAS, bridgeCommand = DEFAULT_BRIDGE_COMMAND, stagingRemotePath, runProcess = defaultRunProcess }) {
  if (!BRIDGE_COMMAND_PATTERN.test(bridgeCommand ?? "")) refuse("not_configured", "the bridge command is missing or has unsupported characters");
  if (stagingRemotePath !== undefined && !REMOTE_PATH_PATTERN.test(stagingRemotePath)) refuse("not_configured", "the remote staging path has unsupported characters");
  return {
    callBridge(subcommand, { requestId, stdinBytes, timeoutMs = 120000 } = {}) {
      const suffix = requestId === undefined ? "" : ` ${requestId}`;
      if (requestId !== undefined && !REQUEST_ID_PATTERN.test(requestId)) refuse("invalid_input", "request id has an unsupported shape");
      const viaGateway = subcommand === "submit";
      const command = viaGateway ? GATEWAY_REVIEW_SUBMIT_COMMAND : `${bridgeCommand} ${subcommand}${suffix}`;
      const run = runProcess("ssh", ["-T", "-o", "BatchMode=yes", alias, command], {
        input: stdinBytes,
        timeoutMs,
      });
      const lastLine = run.stdout.split("\n").map((line) => line.trim()).filter(Boolean).pop();
      let parsed = null;
      try { parsed = lastLine ? JSON.parse(lastLine) : null; } catch { parsed = null; }
      // Gateway exit 2 (invalid input) and 3 (profile or authorization) are refused before anything is committed. The
      // Gateway's `request id:` line on stderr is a diagnostic and is not read.
      const refusedBeforeCommit = viaGateway ? [2, 3] : [2];
      if (parsed && typeof parsed === "object" && parsed.error && refusedBeforeCommit.includes(run.status)) {
        return { ok: false, error: { code: String(parsed.error.code), message: String(parsed.error.message ?? "") } };
      }
      // Exit 4..6 may follow the commit (for example gateway_result_unknown): the request may exist, so the outcome is
      // unknown and the same request id is retried; the bridge answers it idempotently.
      if (viaGateway && parsed && typeof parsed === "object" && parsed.error && run.status >= 4 && run.status <= 6) {
        const code = GATEWAY_ERROR_CODE_PATTERN.test(String(parsed.error.code)) ? String(parsed.error.code) : undefined;
        refuse("transport_failed", `the Gateway answered${code ? ` ${code}` : " with an error"}; the request may exist, so its outcome is unknown`,
          { outcome_unknown: true, ...(code ? { remote_code: code } : {}) });
      }
      if (run.status !== 0 || run.error_code || !parsed || typeof parsed !== "object") {
        refuse("transport_failed", "the bridge call did not complete; its outcome is unknown", { outcome_unknown: true });
      }
      return { ok: true, payload: parsed };
    },
    uploadBundle(localPath, requestId) {
      if (!stagingRemotePath) refuse("not_configured", "the remote staging path is required to upload a bundle");
      const remote = `${stagingRemotePath.replace(/[\\/]+$/u, "")}/${requestId}.bundle`;
      const run = runProcess("scp", ["-q", "-o", "BatchMode=yes", localPath, `${alias}:${remote}`], { timeoutMs: 600000 });
      if (run.status !== 0 || run.error_code) refuse("upload_failed", "the bundle could not be uploaded to the staging directory");
    },
  };
}

function unwrap(call) {
  if (!call.ok) refuse("remote_refused", `${call.error.code}: ${call.error.message}`, { remote_code: call.error.code });
  return call.payload;
}

// --------------------------------------------------------------------------- //
// Operations
// --------------------------------------------------------------------------- //

export function submitRemoteReview({
  repoRoot, repoId, role, mode, base, head, scope = "", acceptanceCriteria = [],
  requestId = newRequestId(), stateDir, bundleDir, transport, runGit = defaultRunGit, now = () => Date.now(),
}) {
  assertRemoteRoleMode(role, mode);
  if (!REQUEST_ID_PATTERN.test(requestId ?? "") || !REPO_ID_PATTERN.test(repoId ?? "")) {
    refuse("invalid_input", "request id or repo id has an unsupported shape");
  }
  const frozen = freezeCommitTarget({ repoRoot, base, head, runGit });
  // The bundle lives in a directory only this attempt knows. Its file is named after the request id, so two
  // submissions of one id would otherwise share the file: the one refused below would rebuild it under the
  // winner's upload and then delete it in its own cleanup.
  let attemptDir = null;
  if (!frozen.pushed) {
    mkdirSync(bundleDir, { recursive: true, mode: 0o700 });
    attemptDir = mkdtempSync(path.join(bundleDir, `${requestId}-`));
  }
  try {
    const bundle = attemptDir === null ? null : createReviewBundle({ repoRoot, frozen, requestId, outDir: attemptDir, runGit });
    const request = buildReviewRequest({ requestId, repoId, role, mode, frozen, bundle, scope, acceptanceCriteria });
    const requestSha256 = sha256Hex(JSON.stringify(request));
    // A request id names one request for good: an accepted one, or a different one, must not replace the record
    // the result is later checked against. Only an identical, not-yet-accepted request may be sent again.
    const existing = readRecordIfPresent(stateDir, requestId);
    if (existing !== null && (existing.submitted === true || existing.request_sha256 !== requestSha256)) {
      refuse("request_id_in_use", "this request id already belongs to another or an already accepted request; use a new id");
    }
    const record = existing ?? {
      schema: 1,
      request_id: requestId,
      repo_id: repoId,
      role,
      mode,
      target: request.target,
      repo_binding: request.repo_binding,
      local_head: frozen.localHead,
      bundle: request.bundle,
      request_sha256: requestSha256,
      created_at: now(),
      submitted: false,
    };
    // Persisted before anything leaves this machine, and only by whoever creates it: a record is never replaced by a
    // different request, so the rewrite after acceptance below always starts from a record that is this request's own.
    if (existing === null && !writeJsonExclusive(recordPath(stateDir, requestId), record)) {
      refuse("request_id_in_use", "another submission created a record for this request id first; use a new id");
    }
    if (bundle) transport.uploadBundle(bundle.path, requestId);
    // One JSON document on one line: the bridge reads to the newline and does not wait for end-of-input,
    // which the Windows sshd does not always forward.
    const payload = unwrap(transport.callBridge("submit", { requestId: undefined, stdinBytes: Buffer.from(`${JSON.stringify(request)}\n`, "utf8") }));
    const creatorRef = creatorRefOf(payload.creator_ref);
    writeJsonAtomic(recordPath(stateDir, requestId), { ...record, submitted: true, run_id: payload.run_id ?? null, creator_ref: creatorRef });
    return { request_id: requestId, run_id: payload.run_id ?? null, bridge_state: payload.bridge_state ?? null, creator_ref: creatorRef, bundled: bundle !== null };
  } finally {
    if (attemptDir !== null) rmSync(attemptDir, { recursive: true, force: true });
  }
}

export function remoteReviewStatus({ requestId, stateDir, transport }) {
  readRecord(stateDir, requestId);
  return unwrap(transport.callBridge("status", { requestId }));
}

export function cancelRemoteReview({ requestId, stateDir, transport }) {
  readRecord(stateDir, requestId);
  return unwrap(transport.callBridge("cancel", { requestId }));
}

export function purgeRemoteReview({ requestId, stateDir, transport }) {
  readRecord(stateDir, requestId);
  const done = unwrap(transport.callBridge("purge", { requestId }));
  rmSync(recordPath(stateDir, requestId), { force: true });
  return done;
}

// --------------------------------------------------------------------------- //
// Result verification
// --------------------------------------------------------------------------- //

function receipt(status, classification, reason, extra = {}) {
  return { status, classification, reason, executor: REMOTE_REVIEW_EXECUTOR, sealed_admission: false, ...extra };
}

function decodeFiles(payload) {
  const files = {};
  let total = 0;
  for (const [name, entry] of Object.entries(payload.files ?? {})) {
    if (name !== path.basename(name) || name === "result.json") return null;
    if (typeof entry?.base64 !== "string") return null;
    const bytes = Buffer.from(entry.base64, "base64");
    total += bytes.length;
    if (total > MAX_RESULT_BYTES || bytes.length !== entry.bytes || sha256Hex(bytes) !== entry.sha256) return null;
    files[name] = bytes;
  }
  return files;
}

/**
 * Verify a bridge `result` payload against the local record and the current repository, then
 * run the existing readers over the exact report bytes. Pure apart from `runGit`.
 */
export function verifyRemoteResult({ payload, record, repoRoot, runGit = defaultRunGit }) {
  const meta = payload?.result;
  if (!meta || payload.status !== "succeeded" || payload.request_id !== record.request_id
    || meta.request_id !== record.request_id || meta.repo_id !== record.repo_id
    || meta.role !== record.role || meta.mode !== record.mode
    || !isDeepStrictEqual(meta.target, record.target)) { // key order is not part of the contract
    return receipt("failed", "remote_result_invalid", "the result does not match the request this machine submitted");
  }
  const reviewer = meta.reviewer;
  if (reviewer?.cli !== REMOTE_REVIEWER_CLI
    || !["version", "session_id", "provider_id", "model_id"].every((key) => typeof reviewer[key] === "string" && reviewer[key] !== "")) {
    return receipt("failed", "remote_result_invalid", "the result does not name a complete OpenCode reviewer identity");
  }
  const files = decodeFiles(payload);
  if (!files || !files[REPORT_NAME]) return receipt("failed", "remote_result_invalid", "the returned files do not match their recorded digests");
  // result.json is the worker's own record of what it produced: the report is only accepted when that record
  // names it with a digest, and the returned files are exactly the recorded ones (the bridge builds them from it).
  const declared = meta.files;
  if (declared === null || typeof declared !== "object" || Array.isArray(declared) || !Object.hasOwn(declared, REPORT_NAME)
    || !Object.values(declared).every((entry) => typeof entry?.sha256 === "string" && SHA256_PATTERN.test(entry.sha256))) {
    return receipt("failed", "remote_result_invalid", "result.json does not bind the returned report by digest");
  }
  const returned = Object.keys(files).sort();
  if (!isDeepStrictEqual(returned, Object.keys(declared).sort())) {
    return receipt("failed", "remote_result_invalid", "the returned files are not the ones result.json declares");
  }
  for (const [name, entry] of Object.entries(declared)) {
    if (sha256Hex(files[name]) !== entry.sha256) {
      return receipt("failed", "remote_result_invalid", "result.json and the returned files disagree");
    }
  }

  const head = runGit(["rev-parse", "HEAD"], { cwd: repoRoot });
  const tracked = runGit(["status", "--porcelain", "--untracked-files=no"], { cwd: repoRoot });
  if (head.status !== 0 || head.stdout.trim() !== record.local_head || tracked.status !== 0 || tracked.stdout.trim() !== "") {
    return receipt("failed", "remote_target_changed", "this repository's HEAD or tracked files changed after the review was submitted; the report no longer describes it");
  }

  const reportText = files[REPORT_NAME].toString("utf8");
  const common = {
    request_id: record.request_id,
    reviewer: { cli: reviewer.cli, version: reviewer.version, session_id: reviewer.session_id, provider_id: reviewer.provider_id, model_id: reviewer.model_id },
    report_sha256: sha256Hex(files[REPORT_NAME]),
    reviewed_target: record.target.head,
    file_names: Object.keys(files).sort(),
    // Known only from the submit answer; never a verification input, so a record without one is not a failure.
    creator_ref: creatorRefOf(record.creator_ref),
  };
  const dispatchId = record.request_id;
  if (record.mode === "ordinary-primary") {
    const verdict = readPrimaryReviewVerdict(reportText);
    if (!verdict.ok) return receipt("failed", "remote_report_contract_invalid", verdict.reason, common);
    let assessment = null;
    try {
      assessment = readReviewGuaranteeAssessment(reportText, { reviewedTarget: record.target.head, dispatchId, findingIds: verdict.finding_ids });
    } catch (error) {
      if (verdict.verdict !== "blocked") {
        return receipt("failed", "remote_assessment_invalid", String(error.message).replace(/^review_guarantee_assessment_invalid: /u, ""), common);
      }
    }
    return receipt(verdict.verdict, "remote_review_completed", null, {
      ...common,
      verdict: verdict.verdict,
      finding_ids: verdict.finding_ids,
      guarantee_assessment: assessment ? { next_actions: assessment.next_actions, requires_tl_ruling: assessment.requires_tl_ruling, requires_clarification: assessment.requires_clarification } : null,
    });
  }
  // audit-only: advisory report plus a Guarantee Assessment bound to this target; no merge-gate credit.
  let assessment;
  try {
    assessment = readReviewGuaranteeAssessment(reportText, { reviewedTarget: record.target.head, dispatchId });
  } catch (error) {
    return receipt("failed", "remote_assessment_invalid", String(error.message).replace(/^review_guarantee_assessment_invalid: /u, ""), common);
  }
  return receipt("completed", "remote_audit_completed", null, {
    ...common,
    verdict: null,
    guarantee_assessment: { next_actions: assessment.next_actions, requires_tl_ruling: assessment.requires_tl_ruling, requires_clarification: assessment.requires_clarification },
  });
}

/** Fetch, verify and (when an out dir is given) write the exact report and a receipt. */
export function fetchRemoteReview({ requestId, repoRoot, stateDir, transport, outDir, runGit = defaultRunGit }) {
  const record = readRecord(stateDir, requestId);
  const payload = unwrap(transport.callBridge("result", { requestId }));
  const verified = verifyRemoteResult({ payload, record, repoRoot, runGit });
  if (outDir && payload?.files?.[REPORT_NAME] && verified.status !== "failed") {
    const report = Buffer.from(payload.files[REPORT_NAME].base64, "base64");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, `remote-review-${requestId}.report.md`), report);
    writeJsonAtomic(path.join(outDir, `remote-review-${requestId}.receipt.json`), verified);
  }
  return verified;
}

export function localRecordExists(stateDir, requestId) {
  try {
    return statSync(recordPath(stateDir, requestId)).isFile();
  } catch {
    return false;
  }
}
