#!/usr/bin/env node
/**
 * write-second-review-sticky-gated.mjs
 *
 * Disposition-bound sticky create/update write primitive with a write-before
 * credential-literal gate (design D1 / D2). Assert and GitHub write share one
 * in-memory Buffer (no TOCTOU re-read of the body file after assert).
 *
 * Usage:
 *   node write-second-review-sticky-gated.mjs <sidecar.json> (absolute, or relative to cwd)
 *
 * Sidecar allowlist shape (renderer-owned):
 *   {
 *     schema: "devpro-second-review-sticky-credential-gate-sidecar/v1",
 *     digest: string,              // REQUIRED (fail-closed if missing)
 *     disposition: "create" | "update" | "blocked",
 *     repository_slug: "owner/repo",
 *     pr_number?: number,          // create
 *     comment_id?: number|string,  // update
 *     dispatch_id?: string,
 *     body_file: string,           // absolute, or relative to cwd
 *     materialTexts?: string[],
 *     explicitDenyList?: string[],
 *     quiet_jq?: string
 *   }
 *
 * The sidecar path argument (absolute, or relative to cwd) is resolved once at
 * entry (design D4); the resolved absolute path MUST then be under repo
 * notes/tmp/sticky-credential-gate-*.json or a carrier observability
 * sticky-credential-gate-sidecar.json (sibling observability-context.json
 * required). Arbitrary paths are rejected.
 *
 * On credential hit: non-zero exit, writes sticky-write-result[-<dispatch>].json
 * beside the sidecar (classification sticky_credential_literal_blocked; no
 * secret), and does not call gh.
 */

import { createHash } from "node:crypto";
import { reviewGithubSpawnSync as spawnSync } from "./lib/second-review-github-transport.mjs";
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectCliInvocation } from "./lib/cli-entry.mjs";
import { SECOND_REVIEW_COMMENT_QUIET_JQ } from "./lib/second-review-comment-fields.mjs";
import { controlEvidenceRoot, assertDispatchReviewAuthority } from "./hooks/lib/second-review-control-evidence.mjs";
import { isPlainObject } from "./lib/primitives.mjs";
import { parseSecondReviewStickyAuthorityBody } from "./hooks/lib/second-review-sticky-authority.mjs";
import { readReviewGuaranteeAssessment } from "./review-guarantee-assessment.mjs";
import { SECOND_REVIEW_VERDICT_REASON_MAX_BYTES } from "./second-review-material-contract.mjs";
import {
  assertStickyBodyCredentialFree,
  credentialGateTelemetry,
  STICKY_CREDENTIAL_LITERAL_BLOCKED,
} from "./lib/second-review-sticky-credential-gate.mjs";

export const STICKY_CREDENTIAL_GATE_SIDECAR_SCHEMA =
  "devpro-second-review-sticky-credential-gate-sidecar/v1";
export const STICKY_WRITE_RESULT_BASENAME = "sticky-write-result.json";
export const STICKY_CREDENTIAL_GATE_SIDECAR_BASENAME = "sticky-credential-gate-sidecar.json";
export const STICKY_WRITE_QUIET_JQ = SECOND_REVIEW_COMMENT_QUIET_JQ;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_GATED_WRITE_REPO_ROOT = path.resolve(scriptDir, "../..");

const SIDECAR_KEYS = new Set([
  "schema",
  "digest",
  "disposition",
  "repository_slug",
  "pr_number",
  "comment_id",
  "dispatch_id",
  "body_file",
  "materialTexts",
  "explicitDenyList",
  "quiet_jq",
  "credential_gate_mode",
  "required_verdict",
]);

const NOTES_TMP_SIDECAR_RE = /^sticky-credential-gate-[A-Za-z0-9._-]+\.json$/;
const DISPATCH_ID_RE = /^[A-Za-z0-9._-]+$/;

function fail(message, classification = "sticky_credential_gate_sidecar_invalid") {
  const payload = { ok: false, classification, error: message };
  process.stderr.write(`${JSON.stringify(payload)}\n`);
  process.exitCode = 1;
  return payload;
}

// Every non-credential failure path also prints its typed result on stderr (the credential-hit path already does),
// so an external evaluator that only sees exit code + stderr can still classify the failure without reading sticky-write-result*.json.
function emitFailureResult(result) {
  process.stderr.write(`${JSON.stringify(result)}\n`);
}

export function stickyWriteResultBasename(dispatchId) {
  if (typeof dispatchId === "string" && DISPATCH_ID_RE.test(dispatchId)) {
    return `sticky-write-result-${dispatchId}.json`;
  }
  return STICKY_WRITE_RESULT_BASENAME;
}

export function assertSidecarPathAllowlisted(sidecarPath, repoRoot = DEFAULT_GATED_WRITE_REPO_ROOT) {
  if (typeof sidecarPath !== "string" || sidecarPath.length === 0) {
    throw Object.assign(new Error("sidecar path is required"), {
      classification: "sticky_credential_gate_sidecar_invalid",
    });
  }
  if (!path.isAbsolute(sidecarPath)) {
    throw Object.assign(new Error("sidecar path must be absolute"), {
      classification: "sticky_credential_gate_sidecar_invalid",
    });
  }
  const resolved = path.resolve(sidecarPath);
  const base = path.basename(resolved);
  const notesTmp = path.resolve(repoRoot, "notes", "tmp");
  const notesTmpPrefix = notesTmp.endsWith(path.sep) ? notesTmp : `${notesTmp}${path.sep}`;
  if (resolved.startsWith(notesTmpPrefix) && NOTES_TMP_SIDECAR_RE.test(base)) {
    return resolved;
  }
  if (base === STICKY_CREDENTIAL_GATE_SIDECAR_BASENAME) {
    const crossReviewRoot = path.resolve(repoRoot, "notes", "cross-review");
    const crossReviewPrefix = crossReviewRoot.endsWith(path.sep)
      ? crossReviewRoot
      : `${crossReviewRoot}${path.sep}`;
    if (!resolved.startsWith(crossReviewPrefix)) {
      throw Object.assign(
        new Error("carrier sidecar must be under notes/cross-review/"),
        { classification: "sticky_credential_gate_sidecar_invalid" },
      );
    }
    const sibling = path.join(path.dirname(resolved), "observability-context.json");
    if (existsSync(sibling)) {
      return resolved;
    }
    throw Object.assign(
      new Error("carrier sidecar requires sibling observability-context.json"),
      { classification: "sticky_credential_gate_sidecar_invalid" },
    );
  }
  throw Object.assign(
    new Error(
      "sidecar path must be under notes/tmp/sticky-credential-gate-*.json or carrier sticky-credential-gate-sidecar.json",
    ),
    { classification: "sticky_credential_gate_sidecar_invalid" },
  );
}

function writeResult(sidecarPath, result, dispatchId) {
  const basename = stickyWriteResultBasename(dispatchId ?? result?.dispatch_id);
  const outPath = path.join(path.dirname(sidecarPath), basename);
  const payload = {
    ...result,
    ...(typeof dispatchId === "string" && DISPATCH_ID_RE.test(dispatchId)
      ? { dispatch_id: dispatchId }
      : {}),
  };
  writeFileSync(outPath, `${JSON.stringify(payload)}\n`, "utf8");
  return outPath;
}

/** Secondary result-file I/O must never override the CLI exit status (esp. after gh succeeded). */
function writeResultBestEffort(sidecarPath, result, dispatchId) {
  try {
    writeResult(sidecarPath, result, dispatchId);
  } catch {
    // ignore secondary write failure
  }
}

// The final physical line is the provenance footer, so blank lines at EOF would fail a
// finished review only after it was published, and they carry no content to preserve.
function withSingleTrailingNewline(bodyBuffer) {
  const text = bodyBuffer.toString("utf8");
  const trimmed = text.replace(/(?:\r?\n){2,}$/, "\n");
  return trimmed === text ? bodyBuffer : Buffer.from(trimmed, "utf8");
}

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function loadCredentialGateSidecar(sidecarPath, {
  repoRoot = DEFAULT_GATED_WRITE_REPO_ROOT,
  enforcePathAllowlist = true,
} = {}) {
  if (typeof sidecarPath !== "string" || sidecarPath.length === 0) {
    throw Object.assign(new Error("sidecar path is required"), {
      classification: "sticky_credential_gate_sidecar_invalid",
    });
  }
  if (!path.isAbsolute(sidecarPath)) {
    throw Object.assign(new Error("sidecar path must be absolute"), {
      classification: "sticky_credential_gate_sidecar_invalid",
    });
  }
  if (enforcePathAllowlist) {
    assertSidecarPathAllowlisted(sidecarPath, repoRoot);
  }
  if (!existsSync(sidecarPath)) {
    throw Object.assign(new Error(`sidecar missing: ${sidecarPath}`), {
      classification: "sticky_credential_gate_sidecar_invalid",
    });
  }
  const raw = readFileSync(sidecarPath);
  let parsed;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    throw Object.assign(new Error(`sidecar is not valid JSON: ${error.message}`), {
      classification: "sticky_credential_gate_sidecar_invalid",
    });
  }
  if (!isPlainObject(parsed)) {
    throw Object.assign(new Error("sidecar must be a JSON object"), {
      classification: "sticky_credential_gate_sidecar_invalid",
    });
  }
  for (const key of Object.keys(parsed)) {
    if (!SIDECAR_KEYS.has(key)) {
      throw Object.assign(new Error(`sidecar has disallowed key: ${key}`), {
        classification: "sticky_credential_gate_sidecar_invalid",
      });
    }
  }
  if (parsed.schema !== STICKY_CREDENTIAL_GATE_SIDECAR_SCHEMA) {
    throw Object.assign(new Error("sidecar schema mismatch"), {
      classification: "sticky_credential_gate_sidecar_invalid",
    });
  }
  if (typeof parsed.digest !== "string" || parsed.digest.length === 0) {
    throw Object.assign(new Error("sidecar digest is required"), {
      classification: "sticky_credential_gate_sidecar_invalid",
    });
  }
  const withoutDigest = { ...parsed };
  delete withoutDigest.digest;
  const expected = sha256Hex(Buffer.from(JSON.stringify(withoutDigest), "utf8"));
  if (expected !== parsed.digest) {
    throw Object.assign(new Error("sidecar digest mismatch"), {
      classification: "sticky_credential_gate_sidecar_invalid",
    });
  }
  const disposition = parsed.disposition;
  if (disposition !== "create" && disposition !== "update" && disposition !== "blocked") {
    throw Object.assign(new Error("sidecar disposition must be create|update|blocked"), {
      classification: "sticky_credential_gate_sidecar_invalid",
    });
  }
  if (typeof parsed.repository_slug !== "string" || parsed.repository_slug.length === 0) {
    throw Object.assign(new Error("sidecar repository_slug is required"), {
      classification: "sticky_credential_gate_sidecar_invalid",
    });
  }
  if (typeof parsed.body_file !== "string" || parsed.body_file.length === 0) {
    throw Object.assign(new Error("sidecar body_file is required"), {
      classification: "sticky_credential_gate_sidecar_invalid",
    });
  }
  return parsed;
}

export function resolveBodyFilePath(bodyFile, cwd = process.cwd()) {
  return path.isAbsolute(bodyFile) ? bodyFile : path.resolve(cwd, bodyFile);
}

// D4: one-time entry resolution for a possibly-relative sidecarPath. Every
// downstream step (allowlist, existsSync, readFileSync, and every
// writeResultBestEffort) MUST use this same resolved absolute path — never
// the raw input — so they all agree on one cwd basis (NFR4). Absolute input
// is returned unchanged (byte-identical; FR3 — runner callers are unaffected).
function resolveSidecarPath(sidecarPath, cwd) {
  if (typeof sidecarPath !== "string" || sidecarPath.length === 0) {
    throw Object.assign(new Error("sidecar path is required"), {
      classification: "sticky_credential_gate_sidecar_invalid",
    });
  }
  return path.isAbsolute(sidecarPath) ? sidecarPath : path.resolve(cwd, sidecarPath);
}

/**
 * @param {{
 *   sidecarPath: string,
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   spawnSyncImpl?: typeof spawnSync,
 *   repoRoot?: string,
 *   enforcePathAllowlist?: boolean,
 * }} args
 */
export function runGatedStickyWrite({
  sidecarPath,
  cwd = process.cwd(),
  env = process.env,
  spawnSyncImpl = spawnSync,
  repoRoot = DEFAULT_GATED_WRITE_REPO_ROOT,
  enforcePathAllowlist = true,
}) {
  let resolvedSidecarPath;
  try {
    resolvedSidecarPath = resolveSidecarPath(sidecarPath, cwd);
  } catch (error) {
    const classification = error.classification ?? "sticky_credential_gate_sidecar_invalid";
    const result = {
      ok: false,
      classification,
      error: error.message,
    };
    // No resolved directory exists to write a best-effort result file beside
    // (sidecarPath itself is missing/non-string) — stderr is the only channel.
    emitFailureResult(result);
    return { status: 1, result };
  }

  let sidecar;
  try {
    sidecar = loadCredentialGateSidecar(resolvedSidecarPath, { repoRoot, enforcePathAllowlist });
  } catch (error) {
    const classification = error.classification ?? "sticky_credential_gate_sidecar_invalid";
    const result = {
      ok: false,
      classification,
      error: error.message,
    };
    writeResultBestEffort(resolvedSidecarPath, result);
    emitFailureResult(result);
    return { status: 1, result };
  }

  const dispatchId = typeof sidecar.dispatch_id === "string" ? sidecar.dispatch_id : undefined;

  if (sidecar.disposition === "blocked") {
    const result = {
      ok: false,
      classification: "sticky_write_disposition_blocked",
      error: "disposition is blocked; no GitHub write",
    };
    writeResultBestEffort(resolvedSidecarPath, result, dispatchId);
    emitFailureResult(result);
    return { status: 1, result };
  }

  const bodyPath = resolveBodyFilePath(sidecar.body_file, cwd);
  if (!existsSync(bodyPath)) {
    const result = {
      ok: false,
      classification: "sticky_write_body_missing",
      error: `body file missing: ${bodyPath}`,
    };
    writeResultBestEffort(resolvedSidecarPath, result, dispatchId);
    emitFailureResult(result);
    return { status: 1, result };
  }

  // Single Buffer for assert + write (design D1 TOCTOU).
  // credential_gate_mode `shape-and-explicit-only` permits live-read packets that
  // omit embedded material; it MUST NOT drop already-provided materialTexts.
  const bodyBuffer = withSingleTrailingNewline(readFileSync(bodyPath));
  const gate = assertStickyBodyCredentialFree(bodyBuffer, {
    materialTexts: sidecar.materialTexts,
    explicitDenyList: sidecar.explicitDenyList,
    repositorySlug: sidecar.repository_slug,
    classification: STICKY_CREDENTIAL_LITERAL_BLOCKED,
  });
  if (!gate.ok) {
    const result = {
      ok: false,
      ...credentialGateTelemetry(gate),
    };
    writeResultBestEffort(resolvedSidecarPath, result, dispatchId);
    process.stderr.write(`${JSON.stringify(result)}\n`);
    return { status: 1, result };
  }

  if (Object.hasOwn(sidecar, "required_verdict")) {
    const { verdict } = parseSecondReviewStickyAuthorityBody(bodyBuffer.toString("utf8"));
    if (sidecar.required_verdict !== "CRITICAL" || verdict !== sidecar.required_verdict) {
      const result = { ok: false, classification: "sticky_required_verdict_mismatch", error: "Recorded Critical findings require verdict CRITICAL" };
      writeResultBestEffort(resolvedSidecarPath, result, dispatchId);
      emitFailureResult(result);
      return { status: 1, result };
    }
  }

  try {
    // Observability carriers pin their original repository evidence root even
    // when the writer runs in a neutral cwd. Legacy tmp callers use repoRoot.
    const contextPath = path.join(path.dirname(resolvedSidecarPath), "observability-context.json");
    const context = existsSync(contextPath) ? JSON.parse(readFileSync(contextPath, "utf8")) : null;
    const parsed = parseSecondReviewStickyAuthorityBody(bodyBuffer.toString("utf8"));
    const evidenceRoot = controlEvidenceRoot(env, repoRoot);
    if (context?.control_evidence_root !== undefined && context.control_evidence_root !== evidenceRoot) throw new Error("sticky context evidence root differs from the writer repository");
    if (dispatchId) assertDispatchReviewAuthority({
      rootDir: evidenceRoot,
      dispatchId, repositorySlug: sidecar.repository_slug,
      prNumber: context?.pr_number ?? sidecar.pr_number,
      headRefOid: context?.head_ref_oid ?? parsed.last_reviewed_sha });
  } catch (error) {
    const result = { ok: false, classification: "sticky_operator_disposition_blocked", error: error.message };
    writeResultBestEffort(resolvedSidecarPath, result, dispatchId);
    emitFailureResult(result);
    return { status: 1, result };
  }

  const quietJq = typeof sidecar.quiet_jq === "string" && sidecar.quiet_jq.length > 0
    ? sidecar.quiet_jq
    : STICKY_WRITE_QUIET_JQ;
  const endpoint = sidecar.disposition === "update"
    ? `repos/${sidecar.repository_slug}/issues/comments/${sidecar.comment_id}`
    : `repos/${sidecar.repository_slug}/issues/${sidecar.pr_number}/comments`;
  const method = sidecar.disposition === "update" ? "PATCH" : "POST";

  // Use --input - with JSON {body} so the same Buffer is the write payload
  // (equivalent quiet jq surface to the prior -F body=@file recipe).
  const gh = spawnSyncImpl("gh", [
    "api",
    endpoint,
    "--method",
    method,
    "--input",
    "-",
    "--jq",
    quietJq,
  ], {
    cwd,
    env: {
      ...env,
      GH_REPO: sidecar.repository_slug,
    },
    input: JSON.stringify({ body: bodyBuffer.toString("utf8") }),
    ...(env.DEVPRO_SECOND_REVIEW_GITHUB_TRANSPORT_FILE ? {reviewerWrite:{dispatchId,bodySha256:createHash('sha256').update(bodyBuffer).digest('hex')}} : {}),
    encoding: "utf8",
    maxBuffer: 5 * 1024 * 1024,
    timeout: 30000,
  });

  if (gh.status !== 0) {
    const result = {
      ok: false,
      classification: "sticky_write_gh_failed",
      error: gh.error?.message ?? "gh api write failed",
      stderr_tail: String(gh.stderr ?? "").slice(-1000),
      ...(gh.error?.code === 'write_outcome_unknown' ? {
        write_outcome: 'unknown',
        next_action: 'Inspect the original operation journal and GitHub comment readback before continuing; do not retry with a new ticket, task or dispatch.',
      } : {}),
    };
    writeResultBestEffort(resolvedSidecarPath, result, dispatchId);
    emitFailureResult(result);
    return { status: gh.status === null ? 1 : gh.status, result, gh };
  }

  const result = {
    ok: true,
    classification: "sticky_write_ok",
    disposition: sidecar.disposition,
    stdout: String(gh.stdout ?? ""),
    ...(gh.readback_only ? {readback_only:true} : {}),
  };
  // Serialize the existing five-field completion from the exact written body.
  // The reviewer still performs independent readback and emits the report;
  // the runner never substitutes this helper for authenticated CLI completion.
  try {
    const comment = JSON.parse(result.stdout);
    const body = bodyBuffer.toString("utf8");
    const parsed = parseSecondReviewStickyAuthorityBody(body);
    const expectedUrl = `https://github.com/${sidecar.repository_slug}/pull/${sidecar.pr_number}#issuecomment-${comment.id}`;
    if (parsed.status === "valid" && comment.body === body && comment.html_url === expectedUrl) {
      const { report } = readReviewGuaranteeAssessment(body, {
        reviewedTarget: parsed.last_reviewed_sha, dispatchId: parsed.dispatch_id,
      });
      const reason = `${parsed.reason}\n\n## Guarantee Assessment\n\`\`\`json\n${JSON.stringify(report)}\n\`\`\``;
      if (Buffer.byteLength(reason, "utf8") <= SECOND_REVIEW_VERDICT_REASON_MAX_BYTES) {
        result.completion_json = JSON.stringify({
          sticky_comment_url: comment.html_url,
          verdict: parsed.verdict,
          last_reviewed_sha: parsed.last_reviewed_sha,
          reviewer_model: parsed.reviewer_model,
          reason,
        });
      }
    }
  } catch {
    // The remote write has succeeded. Legacy/noncanonical output must not
    // turn that into a retryable failure or manufacture a completion.
  }
  // PRIM-F18: GitHub write already succeeded — result-file failure MUST NOT non-zero the CLI.
  writeResultBestEffort(resolvedSidecarPath, result, dispatchId);
  const stdout = result.completion_json
    ? JSON.stringify({ ...JSON.parse(result.stdout), completion_json: result.completion_json })
    : result.stdout;
  if (stdout) process.stdout.write(stdout.endsWith("\n") ? stdout : `${stdout}\n`);
  return { status: 0, result, gh };
}

export function main(argv = process.argv.slice(2), options = {}) {
  const sidecarPath = argv[0];
  if (!sidecarPath) {
    fail("usage: write-second-review-sticky-gated.mjs <sidecar.json> (absolute, or relative to cwd)");
    return 1;
  }
  const { status } = runGatedStickyWrite({
    sidecarPath,
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    spawnSyncImpl: options.spawnSyncImpl ?? spawnSync,
    repoRoot: options.repoRoot ?? DEFAULT_GATED_WRITE_REPO_ROOT,
    enforcePathAllowlist: options.enforcePathAllowlist !== false,
  });
  process.exitCode = status === 0 ? 0 : 1;
  return process.exitCode;
}

if (isDirectCliInvocation(import.meta.url) || (
  process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
)) {
  main();
}
