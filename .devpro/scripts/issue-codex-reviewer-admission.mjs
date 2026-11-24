#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  CODEX_REVIEWER_RECOVERY_REQUEST_KEYS,
  CODEX_REVIEWER_REQUEST_KEYS,
  decodeStrictUtf8,
  hasExactOrderedKeys,
  issueCodexReviewerAdmission,
  parseJsonDuplicateAware,
  readBoundedRequestFile,
  recoverCodexReviewerAdmission,
} from "./hooks/lib/admission-record.mjs";

const MAX_REQUEST = 64 * 1024;

export function parseAdmissionRequestFile(requestPath) {
  const loaded = readBoundedRequestFile(requestPath, MAX_REQUEST);
  if (!loaded.ok) return loaded;
  const { bytes } = loaded;
  try {
    const value = parseJsonDuplicateAware(decodeStrictUtf8(bytes, "request-unparseable"), "request-unparseable");
    if (!hasExactOrderedKeys(value, CODEX_REVIEWER_REQUEST_KEYS)) return { ok: false, code: "request-shape-invalid" };
    return { ok: true, request: value };
  } catch (error) { return { ok: false, code: error.code ?? "request-unparseable" }; }
}

export function parseAdmissionRecoveryRequestFile(requestPath) {
  const loaded = readBoundedRequestFile(requestPath, MAX_REQUEST);
  if (!loaded.ok) return loaded;
  const { bytes } = loaded;
  try {
    const value = parseJsonDuplicateAware(decodeStrictUtf8(bytes, "request-unparseable"), "request-unparseable");
    if (!hasExactOrderedKeys(value, CODEX_REVIEWER_RECOVERY_REQUEST_KEYS)) return { ok: false, code: "request-shape-invalid" };
    return { ok: true, request: value };
  } catch (error) { return { ok: false, code: error.code ?? "request-unparseable" }; }
}

export function runIssueCodexReviewerAdmission(argv, cwd = process.cwd()) {
  if (argv.length !== 2 || !["--request", "--recover"].includes(argv[0]) || typeof argv[1] !== "string") {
    return { exitCode: 2, result: { ok: false, code: "request-shape-invalid" } };
  }
  const parsed = argv[0] === "--request"
    ? parseAdmissionRequestFile(argv[1])
    : parseAdmissionRecoveryRequestFile(argv[1]);
  if (!parsed.ok) return { exitCode: 1, result: parsed };
  const result = argv[0] === "--request"
    ? issueCodexReviewerAdmission({ cwd, request: parsed.request })
    : recoverCodexReviewerAdmission({ cwd, request: parsed.request });
  return { exitCode: result.ok ? 0 : 1, result };
}

// One stderr line for the two closed codes whose usual cause is the caller's cwd (or a moved HEAD) rather than the request itself.
// stdout JSON and the exit code are the contract and stay unchanged. identifier-invalid is the issuer's code for a wrong cwd;
// `--recover` reports the same cwd mistake as intent-tuple-mismatch, so that hint is keyed on the mode and does not apply to `--request`.
export function issuerFailureHint(argv, result) {
  if (result?.ok !== false) return null;
  if (result.code === "identifier-invalid") {
    return "issue-codex-reviewer-admission: identifier-invalid — the process cwd must be the target `.worktree/<change_id>` checkout and `request.change_id` must equal that change id; run `cd .worktree/<change_id>` before invoking the issuer\n";
  }
  if (argv[0] === "--recover" && result.code === "intent-tuple-mismatch") {
    return "issue-codex-reviewer-admission: intent-tuple-mismatch — `--recover` must run from the same `.worktree/<change_id>` checkout the intent was issued from, `request.change_id` must equal that change id, and HEAD must still be the commit the intent was issued for; run `cd .worktree/<change_id>` first, and if HEAD moved after issuing, the intent no longer matches and must be issued again\n";
  }
  return null;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const argv = process.argv.slice(2);
  const outcome = runIssueCodexReviewerAdmission(argv);
  process.stdout.write(`${JSON.stringify(outcome.result)}\n`);
  const hint = issuerFailureHint(argv, outcome.result);
  if (hint !== null) process.stderr.write(hint);
  process.exitCode = outcome.exitCode;
}
