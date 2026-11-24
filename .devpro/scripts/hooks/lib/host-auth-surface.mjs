// host-auth-surface.mjs — Invariant 3 classifier (host-auth sandbox-fault gate).
//
// SSOT for classifying a host-auth reviewer CLI invocation's exit signal
// (`claude -p`, `claude auth status`, `codex …`, `gh auth status`) as one of:
//   - "sandbox-surface-fault" — the failure is a SANDBOX surface limit (no host auth /
//     network inside the sandbox), NOT credential invalidity or a missing binary.
//     Patterns: `Not logged in`, auth/network/permission denied.
//     This MUST NEVER be treated as reviewer real-unavailable, and MUST NOT justify a
//     same-family fallback or a `UNAVAILABLE` verdict until the host re-surfaces
//     evidence (host rerun) OR the user explicitly refuses the rerun.
//   - "real-unavailable" — the CLI binary is genuinely absent (`command not found` /
//     `not installed`), so cross-model review cannot run on this host at all.
//   - "host-fault" — a non-sandbox, non-missing failure surfaced on the HOST (real auth
//     expiry, real network outage on host). Carries host-surface evidence already.
//   - "ok" — exit 0 / no fault signal.
//
// Rule SSOT (prose): code-review-cross-model.md §Second-Opinion / External-CLI Sandbox
// Policy; cross-runtime-parity spec §… `sandbox-surface-fault`. devpro:second-review agent
// fallback step. This module makes the classification MECHANICAL + testable rather than
// prose-only, so a runtime/agent can import one function instead of re-deriving the
// patterns. Pure module: no fs / process / network.

// Sandbox false-negative signatures. Matched case-insensitively against combined
// stdout+stderr text. These are surface-limit evidence, not credential invalidity.
const SANDBOX_FAULT_PATTERNS = Object.freeze([
  /not logged in/i,
  /\bauth(?:entication)?\s+(?:denied|failed|error|required)\b/i,
  /\bnetwork\s+(?:denied|error|unreachable|disabled|blocked)\b/i,
  /\bpermission denied\b/i,
  /\boperation not permitted\b/i,
  /\bEPERM\b/,
  /\bEACCES\b/,
  /\bsandbox\b[^\n]*\b(?:denied|blocked|restricted|disabled)\b/i,
  /\b(?:connect|connection)\b[^\n]*\b(?:refused|timed out|blocked)\b/i,
  // Network-denial errnos (C2): a sandbox that blocks egress typically surfaces these
  // with NO human-readable "network denied" string. Without them, an unknown-surface
  // network failure leaks to host-fault/mayFallback. Treat as sandbox-limit evidence so
  // it fails closed (host rerun required) — a genuine host network outage will re-fail
  // on the host rerun and then surface as host-fault with host evidence.
  /\bENOTFOUND\b/,
  /\bETIMEDOUT\b/,
  /\bECONNREFUSED\b/,
  /\bECONNRESET\b/,
  /\bEAI_AGAIN\b/,
  /\bENETUNREACH\b/,
  /\bEHOSTUNREACH\b/,
]);

// Genuinely-missing binary signatures → real-unavailable (cross-model cannot run here).
// SCOPED to "the CLI executable itself is absent" (C1). A bare `ENOENT` or a generic
// `no such file or directory` is AMBIGUOUS — a present-but-misconfigured CLI emits those
// when it cannot find a config / socket / workdir — so they are deliberately EXCLUDED
// here; mis-classifying them as real-unavailable would set mayFallback=true and break the
// R3 fail-closed invariant. ENOENT only counts when tied to SPAWNING the binary
// (`spawn <cmd> ENOENT` / `posix_spawn ... ENOENT`), the Node/OS shape for "exec target
// not found".
const MISSING_BINARY_PATTERNS = Object.freeze([
  /command not found/i,
  /\bnot installed\b/i,
  /executable file not found/i,
  /is not recognized as an internal or external command/i, // Windows
  /\bspawn\s+\S+\s+ENOENT\b/i, // Node child_process: exec target absent
  /\bposix_spawn\b[^\n]*\bENOENT\b/i,
  /\bno such file or directory\b[^\n]*\b(?:executable|binary|command)\b/i,
]);

// Host-surface evidence markers — when present, the result already carries the
// exit/status + redacted summary + log path required before fallback (the failure was
// surfaced on the host, not inferred from a sandbox). Used by isFallbackAllowed.
const HOST_SURFACE_EVIDENCE_PATTERNS = Object.freeze([
  /\bhost[-\s]?surface\b/i,
  /\bhost[-\s]?rerun\b/i,
  /\bhost runner\b/i,
  /\brequire_escalated\b/i,
  /\blog path\b/i,
]);

function anyMatch(patterns, text) {
  return patterns.some((re) => re.test(text));
}

/**
 * Classify a reviewer CLI exit signal.
 *
 * IMPORTANT precedence (fail-closed against false-unavailable):
 *   sandbox-surface-fault is checked BEFORE real-unavailable, because a sandbox that
 *   denies network can ALSO emit "command not found"-like noise; when sandbox-limit
 *   evidence is present we MUST classify it as a surface fault, never as unavailable.
 *   Only a clean missing-binary signal with NO sandbox-limit evidence is
 *   real-unavailable.
 *
 * @param {number|null} exitCode process exit code (null/undefined if unknown)
 * @param {string} output combined stdout+stderr text
 * @param {{ surface?: "sandbox"|"host"|"unknown" }} [opts] optional invocation surface hint
 * @returns {{
 *   classification: "ok"|"sandbox-surface-fault"|"real-unavailable"|"host-fault",
 *   isSandboxFault: boolean,
 *   mayMarkUnavailable: boolean,
 *   mayFallback: boolean,
 *   requiresHostRerun: boolean,
 *   reason: string
 * }}
 */
export function classifyAuthSurfaceFault(exitCode, output, opts = {}) {
  const text = typeof output === "string" ? output : "";
  const surface = opts.surface || "unknown";

  if ((exitCode === 0 || exitCode === null || exitCode === undefined) && !anyMatch(SANDBOX_FAULT_PATTERNS, text) && !anyMatch(MISSING_BINARY_PATTERNS, text)) {
    return verdict("ok", { reason: "no fault signal" });
  }

  const hasSandboxSignal = anyMatch(SANDBOX_FAULT_PATTERNS, text);
  const hasMissingBinary = anyMatch(MISSING_BINARY_PATTERNS, text);
  const hasHostEvidence = anyMatch(HOST_SURFACE_EVIDENCE_PATTERNS, text);

  // (0) Explicit HOST surface takes precedence over a sandbox-limit string (Important:
  //     host-evidence shadowed by sandbox signal). The CALLER sets surface=host (a
  //     trustworthy host-rerun), so the failure IS host-real even if its output happens
  //     to contain a sandbox-limit phrase. A genuinely missing binary on the host is
  //     still real-unavailable (handled below); everything else on an explicit host
  //     surface is a host-fault → legitimate fallback / UNAVAILABLE is NOT trapped.
  //     (Surface is caller-asserted, so a noisy sandbox echo cannot game this; an
  //     UNKNOWN surface with only host-evidence MARKERS in the text still defers to the
  //     sandbox-fault branch below, fail-closed.)
  if (surface === "host" && !hasMissingBinary) {
    return verdict("host-fault", {
      reason: "fault surfaced on an explicit host runner; fallback / UNAVAILABLE permitted (host-surface evidence present).",
    });
  }

  // (1) Sandbox false-negative — highest precedence on non-host surfaces. A sandbox-limit
  //     signal, OR an auth/network failure observed on a surface explicitly marked
  //     "sandbox", is a sandbox-surface-fault and MUST NOT mark unavailable / fallback
  //     until host rerun.
  if (hasSandboxSignal && surface !== "host") {
    return verdict("sandbox-surface-fault", {
      reason:
        "sandbox auth/network false-negative (Not logged in / denied). " +
        "MUST host-rerun before any fallback or UNAVAILABLE verdict; sandbox limit is surface evidence, not credential invalidity.",
    });
  }

  // (2) Genuinely missing binary with no sandbox-limit noise → real-unavailable.
  if (hasMissingBinary && !hasSandboxSignal) {
    return verdict("real-unavailable", {
      reason: "reviewer CLI binary genuinely absent on host (command not found / not installed).",
    });
  }

  // (3) A fault surfaced on the HOST (surface=host or host-surface evidence present)
  //     that is not a missing binary → host-fault; it already carries host evidence so
  //     fallback / UNAVAILABLE is permitted. (A sandbox-signal on an explicit host
  //     surface also lands here, since branch 1 is gated on surface !== "host".)
  if (surface === "host" || hasHostEvidence) {
    return verdict("host-fault", {
      reason: "fault surfaced on host with host-surface evidence; fallback / UNAVAILABLE permitted.",
    });
  }

  // (4) UNKNOWN-surface non-zero exit with NO host evidence and NO missing-binary signal
  //     — fail CLOSED to sandbox-surface-fault, whether or not a sandbox-limit string was
  //     recognized. Rationale (C1 + rule prose "sandbox auth/network failure 不可直接判
  //     unavailable"): on an unknown surface we cannot prove the failure was credential-
  //     invalid / host-real, and an ambiguous file/error (e.g. a present-but-misconfigured
  //     CLI emitting bare ENOENT) must not enable fallback. A genuine host fault re-fails
  //     on the mandated host rerun and only THEN surfaces (branch 3) as host-fault with
  //     evidence. Missing-binary (branch 2) is the sole unknown-surface path to
  //     real-unavailable, and it is scoped to true executable-absence signals.
  return verdict("sandbox-surface-fault", {
    reason: hasSandboxSignal
      ? "unknown-surface auth/network failure — fail-closed as sandbox-surface-fault; host rerun required before fallback."
      : "unknown-surface non-zero exit with no host-surface evidence — fail-closed as sandbox-surface-fault (ambiguous; cannot prove host-real); host rerun required before fallback / UNAVAILABLE.",
  });
}

/**
 * @param {"ok"|"sandbox-surface-fault"|"real-unavailable"|"host-fault"} classification
 * @param {{ reason: string }} extra
 */
function verdict(classification, { reason }) {
  const isSandboxFault = classification === "sandbox-surface-fault";
  // A reviewer may be marked UNAVAILABLE / fall back ONLY when the fault is NOT a
  // sandbox false-negative — i.e. real-unavailable or a host-surfaced fault.
  const mayMarkUnavailable = classification === "real-unavailable" || classification === "host-fault";
  return Object.freeze({
    classification,
    isSandboxFault,
    mayMarkUnavailable,
    mayFallback: mayMarkUnavailable,
    requiresHostRerun: isSandboxFault,
    reason,
  });
}

/**
 * Convenience guard for callers: may this exit signal justify a same-family fallback or
 * UNAVAILABLE verdict? False when it is (or fails closed to) a sandbox-surface-fault.
 *
 * @param {number|null} exitCode
 * @param {string} output
 * @param {{ surface?: "sandbox"|"host"|"unknown" }} [opts]
 * @returns {boolean}
 */
export function isFallbackAllowed(exitCode, output, opts = {}) {
  return classifyAuthSurfaceFault(exitCode, output, opts).mayFallback;
}

export const __test = Object.freeze({
  SANDBOX_FAULT_PATTERNS,
  MISSING_BINARY_PATTERNS,
  HOST_SURFACE_EVIDENCE_PATTERNS,
});
