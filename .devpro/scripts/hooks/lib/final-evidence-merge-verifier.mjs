/**
 * final-evidence-merge-verifier.mjs
 *
 * design.md D5 (fix-merge-gate-regression-currency): the bounded child
 * process that verifies form (3) — a head-bound seal-final FinalEvidenceRecord
 * — for the Local-Test Gate merge advisory (`pre-tool-gate.mjs`
 * `checkLocalTestGateOnMerge`). ONE file plays TWO roles:
 *
 *   - Parent helper `runFinalEvidenceVerifierChild` — called from the hook
 *     process. Spawns a bounded, shell-less Node child running THIS SAME
 *     file, and classifies the child's outcome with the pure function
 *     `classifyFinalEvidenceVerifierResult`.
 *   - Child entry — when this file is the process entry point
 *     (`process.argv[1]` resolves to this file's URL), it parses a strict
 *     argv contract, dynamically imports the production evidence façade
 *     (`../../review-remediation-evidence.mjs`), calls its
 *     `verifyHeadBoundFinalEvidence`, and prints exactly one strict verdict
 *     line naming the requested change and head.
 *
 * Why bounded in a child, not in the hook process (F-r2-1): a
 * FinalEvidenceRecord's byte size has no writer-side upper bound below the
 * runtime's own V8 string-length ceiling (design D4 "Writer/reader 大小契約").
 * Reading and validating an oversized or pathological record can exhaust the
 * V8 heap, which is a FATAL ABORT — not a catchable exception — so doing this
 * work in the hook process risks the hook terminating before it can emit a
 * block decision. Spawning a separate process with its own
 * `--max-old-space-size` heap cap, a wall-clock timeout, an output cap, and a
 * caller byte budget checked before any buffer is allocated means EVERY
 * failure mode (crash, timeout, heap exhaustion, signal, non-zero exit,
 * malformed/oversized output) simply makes form (3) "not satisfied" — the
 * hook process itself never reads or parses the record (design D4/D5).
 *
 * Import discipline (design D5 "鎖相容性" / D11 source locks):
 *   - This file imports ONLY Node builtins and
 *     `../../lib/regression-head-record.mjs` (`isValidChangeName`,
 *     `REGRESSION_HEAD_SHA_RE`) at module load. There is NO static import of
 *     the production evidence façade and NO import of the internal evidence
 *     core module anywhere in this file (core-importer lock:
 *     `review-remediation-evidence.test.mjs` greps every non-test `.mjs`
 *     under `.devpro/scripts` for that core module's relative path string).
 *   - The façade is loaded with a single dynamic `import()` inside the CHILD
 *     entry point only, after this file has already been spawned as its own
 *     process — never at module top-level, and never inside the parent
 *     helper.
 *   - Neither the parent helper nor the child entry reads the hook runner's
 *     timeout override variable (see `run-hook.mjs`) or any other
 *     environment variable to select the child entry path or to widen the
 *     byte/heap/timeout budget below. The ONLY use of `process.env` here is
 *     building the child's own environment (a copy of the parent's
 *     `process.env` with `NODE_OPTIONS` removed) — never to source the entry
 *     path or budget values themselves.
 *   - This file is not a façade CLI command and is not meant to be run by an
 *     operator; its only production caller is `checkLocalTestGateOnMerge`
 *     (`pre-tool-gate.mjs`). Tests import it directly.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isValidChangeName, REGRESSION_HEAD_SHA_RE } from "../../lib/regression-head-record.mjs";

/** Strict verdict schema shared by both the success and rejection shapes the
 * child prints. Shared by `classifyFinalEvidenceVerifierResult` and the child-side
 * writers (`writeChildSuccess`/`writeChildRejection`); exported only so tests can
 * build fake-child verdicts. No production module outside this file uses it. */
export const FINAL_EVIDENCE_VERDICT_SCHEMA = "devpro.local-test-merge.final-evidence-verdict/v1";

/**
 * design.md D5 "預算（初值；驗收以 D11 adequacy test 為準）". Frozen so nothing
 * (including a caller passing `deps.finalEvidenceVerifier`) can mutate the
 * production default in place — a caller wanting a different budget for a
 * test MUST build and pass its own object, never patch this one.
 */
export const FINAL_EVIDENCE_VERIFIER_BUDGET = Object.freeze({
  heapMiB: 512,
  timeoutMs: 15000,
  maxOutputBytes: 65536,
  maxRecordBytes: 33554432, // 32 MiB
});

const THIS_FILE = fileURLToPath(import.meta.url);

const SUCCESS_KEYS = ["change_id", "head_sha", "ok", "record_digest_sha256", "schema"];
const REJECTION_KEYS = ["ok", "reason", "schema"];
const DIGEST_HEX_RE = /^[0-9a-f]{64}$/;
const REJECTION_REASON_CODES = [
  "record-exceeds-merge-verifier-budget",
  "record-rejected",
  "argv-invalid",
];

function sameKeySet(obj, expectedKeys) {
  const keys = Object.keys(obj).sort();
  const expected = [...expectedKeys].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

/**
 * Strict single-line JSON parse: `stdout` MUST be exactly `<one JSON line>\n`
 * with no other `\n` anywhere. Returns the parsed plain object, or `null` for
 * anything else (not a string, no trailing LF, more than one line, invalid
 * JSON, or JSON that is not a plain object).
 */
function parseStrictSingleLineJson(stdout) {
  if (typeof stdout !== "string" || stdout.length === 0) return null;
  if (!stdout.endsWith("\n")) return null;
  const body = stdout.slice(0, -1);
  if (body.length === 0 || body.includes("\n")) return null;
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed;
}

/**
 * Pure classifier (design D5 §"classifyFinalEvidenceVerifierResult"): turns a
 * raw `spawnSync` result into `{ satisfied, failure_kind, reason?, status?,
 * signal? }`. ONLY the strict-success branch (status 0, exactly one verdict
 * line, exact key set, schema/ok/change_id/head_sha/digest all matching) ever
 * returns `satisfied: true`. Every other shape — including a well-formed
 * rejection line, a well-formed but ECHO-MISMATCHED success line, extra
 * output, a second line, a non-zero exit without a strict rejection line, a
 * signal, a spawn error, a timeout, or an output overflow — is
 * `satisfied: false` with a `failure_kind` naming which check failed
 * (design D5 step 3 "任何不符 → verifier-output-malformed").
 *
 * @param {{ error?: { code?: string, message?: string } | null, status: number|null, signal: string|null, stdout?: string }} result
 * @param {{ changeId: string, headSha: string }} expected
 */
export function classifyFinalEvidenceVerifierResult(result, { changeId, headSha } = {}) {
  if (result && result.error) {
    const code = result.error.code;
    if (code === "ETIMEDOUT") return { satisfied: false, failure_kind: "verifier-timeout" };
    if (code === "ENOBUFS") return { satisfied: false, failure_kind: "verifier-output-overflow" };
    return {
      satisfied: false,
      failure_kind: "verifier-spawn-failed",
      reason: String(result.error.message ?? result.error),
    };
  }
  if (result && result.signal !== null && result.signal !== undefined) {
    return { satisfied: false, failure_kind: "verifier-signal", signal: result.signal };
  }
  const status = result ? result.status : null;
  if (status === 0) {
    const parsed = parseStrictSingleLineJson(result.stdout);
    if (
      parsed &&
      sameKeySet(parsed, SUCCESS_KEYS) &&
      parsed.schema === FINAL_EVIDENCE_VERDICT_SCHEMA &&
      parsed.ok === true &&
      parsed.change_id === changeId &&
      parsed.head_sha === headSha &&
      typeof parsed.record_digest_sha256 === "string" &&
      DIGEST_HEX_RE.test(parsed.record_digest_sha256)
    ) {
      return { satisfied: true };
    }
    return { satisfied: false, failure_kind: "verifier-output-malformed" };
  }
  if (status === 1) {
    const parsed = parseStrictSingleLineJson(result.stdout);
    const reason = parsed && typeof parsed.reason === "string" ? parsed.reason : null;
    const isStrictRejection =
      parsed &&
      sameKeySet(parsed, REJECTION_KEYS) &&
      parsed.schema === FINAL_EVIDENCE_VERDICT_SCHEMA &&
      parsed.ok === false &&
      typeof reason === "string" &&
      reason.length > 0 &&
      reason.length <= 512 &&
      !reason.includes("\n") &&
      REJECTION_REASON_CODES.some((code) => reason.startsWith(code));
    if (isStrictRejection) {
      if (reason.startsWith("record-exceeds-merge-verifier-budget")) {
        return { satisfied: false, failure_kind: "verifier-budget-exceeded", reason };
      }
      return { satisfied: false, failure_kind: "verifier-rejected", reason };
    }
    return { satisfied: false, failure_kind: "verifier-exit-nonzero", status };
  }
  return { satisfied: false, failure_kind: "verifier-exit-nonzero", status };
}

/**
 * Parent helper (design D5 §"Parent（hook 端）"). Spawns a bounded, shell-less
 * Node child running THIS file with a strict argv contract, then classifies
 * the outcome. `entry`/`budget`/`spawnSyncImpl` exist ONLY for in-process
 * test injection (design D5 "只供 in-process test 注入"); production callers
 * (the hook) never pass them, so production always uses THIS file as the
 * entry and `FINAL_EVIDENCE_VERIFIER_BUDGET` as the budget.
 *
 * @returns {{ satisfied: boolean, failure_kind?: string, reason?: string, status?: number, signal?: string, timeoutMs?: number }}
 */
export function runFinalEvidenceVerifierChild({
  repoRoot,
  changeId,
  headSha,
  entry = THIS_FILE,
  budget = FINAL_EVIDENCE_VERIFIER_BUDGET,
  spawnSyncImpl = spawnSync,
} = {}) {
  if (typeof repoRoot !== "string" || !path.isAbsolute(repoRoot)) {
    return { satisfied: false, failure_kind: "verifier-input-invalid", reason: "repoRoot must be an absolute path" };
  }
  if (!isValidChangeName(changeId)) {
    return { satisfied: false, failure_kind: "verifier-input-invalid", reason: "changeId is not a valid change name" };
  }
  const sha = String(headSha ?? "");
  if (!REGRESSION_HEAD_SHA_RE.test(sha)) {
    return { satisfied: false, failure_kind: "verifier-input-invalid", reason: "headSha is not 40-hex" };
  }
  const { heapMiB, timeoutMs, maxOutputBytes, maxRecordBytes } = budget;

  const env = { ...process.env };
  delete env.NODE_OPTIONS;

  const result = spawnSyncImpl(
    process.execPath,
    [
      `--max-old-space-size=${heapMiB}`,
      entry,
      "--repo-root",
      repoRoot,
      "--change",
      changeId,
      "--head",
      sha,
      "--max-record-bytes",
      String(maxRecordBytes),
    ],
    {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: maxOutputBytes,
      shell: false,
    },
  );

  const classified = classifyFinalEvidenceVerifierResult(result, { changeId, headSha: sha });
  if (classified.failure_kind === "verifier-timeout") {
    return { ...classified, timeoutMs };
  }
  if (classified.failure_kind === "verifier-budget-exceeded") {
    return { ...classified, maxRecordBytes };
  }
  return classified;
}

// ─────────────────────────────────────────────────────────────────────────
// Child entry point (design D5 §"Child")
// ─────────────────────────────────────────────────────────────────────────

/** Strict argv parse: exactly `--repo-root <abs> --change <slug> --head
 * <40-hex> --max-record-bytes <positive integer>`, in that order, no extras. */
function parseChildArgv(argv) {
  if (!Array.isArray(argv) || argv.length !== 8) return null;
  const [flag1, repoRoot, flag2, change, flag3, head, flag4, maxBytesRaw] = argv;
  if (flag1 !== "--repo-root" || flag2 !== "--change" || flag3 !== "--head" || flag4 !== "--max-record-bytes") {
    return null;
  }
  if (typeof repoRoot !== "string" || !path.isAbsolute(repoRoot)) return null;
  if (!isValidChangeName(change)) return null;
  if (!REGRESSION_HEAD_SHA_RE.test(String(head ?? ""))) return null;
  if (!/^[1-9][0-9]*$/.test(String(maxBytesRaw ?? ""))) return null;
  const maxRecordBytes = Number(maxBytesRaw);
  if (!Number.isSafeInteger(maxRecordBytes)) return null;
  return { repoRoot, change, head, maxRecordBytes };
}

function singleLineTruncate(text, maxLen) {
  const oneLine = String(text ?? "").replace(/\s+/g, " ").trim();
  return oneLine.length > maxLen ? oneLine.slice(0, maxLen) : oneLine;
}

/**
 * design D5/D11 remediation F-r1-4: `classifyFinalEvidenceVerifierResult`
 * only accepts a rejection `reason` (the WHOLE string, including this
 * prefix) up to 512 chars — a longer one silently degrades to the generic
 * `verifier-exit-nonzero` failure kind and the specific core error message
 * is lost. `singleLineTruncate(message, 512)` alone left room for the
 * prefix to push the total past 512, so the budget passed to it MUST be
 * `512 - prefix.length`, never the bare `512` the caller's own reason ceiling
 * names. Exported (pure) so a caller-side round-trip through
 * `classifyFinalEvidenceVerifierResult` can be unit-tested without spawning
 * a real child (design D5 "只供 in-process test 注入" precedent).
 */
const RECORD_REJECTED_PREFIX = "record-rejected: ";

export function formatRecordRejectedReason(message) {
  return `${RECORD_REJECTED_PREFIX}${singleLineTruncate(message, 512 - RECORD_REJECTED_PREFIX.length)}`;
}

function writeChildSuccess({ change, head, digest }) {
  const verdict = {
    schema: FINAL_EVIDENCE_VERDICT_SCHEMA,
    ok: true,
    change_id: change,
    head_sha: head,
    record_digest_sha256: digest,
  };
  process.stdout.write(`${JSON.stringify(verdict)}\n`);
  process.exitCode = 0;
}

function writeChildRejection(reason) {
  const verdict = { schema: FINAL_EVIDENCE_VERDICT_SCHEMA, ok: false, reason };
  process.stdout.write(`${JSON.stringify(verdict)}\n`);
  process.exitCode = 1;
}

async function runChildMain() {
  const parsed = parseChildArgv(process.argv.slice(2));
  if (!parsed) {
    writeChildRejection(
      "argv-invalid: expected --repo-root <absolute-path> --change <slug> --head <40-hex> --max-record-bytes <positive integer>",
    );
    return;
  }
  const { repoRoot, change, head, maxRecordBytes } = parsed;
  try {
    // Single dynamic import, only reached inside the spawned child process —
    // never at this file's top level, never from the parent helper above.
    const facadeUrl = new URL("../../review-remediation-evidence.mjs", import.meta.url);
    const { verifyHeadBoundFinalEvidence } = await import(facadeUrl.href);
    const { record } = verifyHeadBoundFinalEvidence({
      repoRoot,
      changeId: change,
      headSha: head,
      maxRecordBytes,
    });
    writeChildSuccess({ change, head, digest: record.record_digest_sha256 });
  } catch (error) {
    const message = String(error?.message ?? error);
    if (message.includes("final-evidence-over-caller-budget")) {
      writeChildRejection(`record-exceeds-merge-verifier-budget: ${maxRecordBytes} bytes`);
    } else {
      writeChildRejection(formatRecordRejectedReason(message));
    }
  }
}

// Only run the child main when THIS file is the process entry point — the
// same `pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url`
// guard the production façade (`review-remediation-evidence.mjs`) uses. When
// this file is merely imported by the parent helper above, `process.argv[1]`
// names whatever script actually launched (the hook, or a test file), so the
// guard is false and none of the child-only code below runs. No top-level
// `await`: the guard only schedules `runChildMain()`, it does not block
// module evaluation.
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runChildMain().catch(() => {
    process.exitCode = 1;
  });
}
