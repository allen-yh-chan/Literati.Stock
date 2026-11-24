import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyAuthSurfaceFault, isFallbackAllowed } from "../hooks/lib/host-auth-surface.mjs";

describe("Invariant 3: host-auth sandbox-surface-fault classifier (lib)", () => {
  it("classifies `Not logged in` as sandbox-surface-fault (never unavailable)", () => {
    const r = classifyAuthSurfaceFault(1, "Not logged in. Run `claude login`.");
    assert.equal(r.classification, "sandbox-surface-fault");
    assert.equal(r.isSandboxFault, true);
    assert.equal(r.mayMarkUnavailable, false);
    assert.equal(r.mayFallback, false);
    assert.equal(r.requiresHostRerun, true);
  });

  it("treats `apiKeySource:none` as neutral init metadata on a successful exit", () => {
    assert.equal(classifyAuthSurfaceFault(0, '{"apiKeySource":"none"}').classification, "ok");
    assert.equal(classifyAuthSurfaceFault(0, "apiKeySource: none").classification, "ok");
    assert.equal(classifyAuthSurfaceFault(0, "apiKeySource=none").classification, "ok");
  });

  it("classifies auth/network/permission denied as sandbox-surface-fault on unknown surface", () => {
    assert.equal(classifyAuthSurfaceFault(1, "authentication denied").classification, "sandbox-surface-fault");
    assert.equal(classifyAuthSurfaceFault(1, "network blocked by sandbox").classification, "sandbox-surface-fault");
    assert.equal(classifyAuthSurfaceFault(1, "permission denied").classification, "sandbox-surface-fault");
    assert.equal(classifyAuthSurfaceFault(126, "EACCES: operation not permitted").classification, "sandbox-surface-fault");
  });

  it("FAILS CLOSED: an auth/network failure on unknown surface NEVER becomes real-unavailable", () => {
    // The core invariant: sandbox false-negative must not justify fallback.
    const r = classifyAuthSurfaceFault(1, "connection refused; auth required");
    assert.notEqual(r.classification, "real-unavailable");
    assert.equal(r.mayFallback, false);
  });

  it("classifies genuinely missing binary (no sandbox noise) as real-unavailable", () => {
    const r = classifyAuthSurfaceFault(127, "codex: command not found");
    assert.equal(r.classification, "real-unavailable");
    assert.equal(r.mayMarkUnavailable, true);
    assert.equal(r.mayFallback, true);
    assert.equal(r.requiresHostRerun, false);
  });

  it("C1: a bare ENOENT / generic 'no such file' (misconfigured present CLI) is NOT real-unavailable", () => {
    // A present-but-misconfigured CLI emits ENOENT for a missing config/socket; treating
    // that as real-unavailable would set mayFallback=true and break R3 fail-closed.
    const bareEnoent = classifyAuthSurfaceFault(1, "Error: ENOENT: no such file or directory, open '/home/u/.codex/config'");
    assert.notEqual(bareEnoent.classification, "real-unavailable");
    assert.equal(bareEnoent.mayFallback, false, "ambiguous file error must not enable fallback");
    const genericNoSuchFile = classifyAuthSurfaceFault(1, "no such file or directory: ~/.config/auth.json");
    assert.notEqual(genericNoSuchFile.classification, "real-unavailable");
  });

  it("C1: spawn ENOENT (exec target absent) IS real-unavailable", () => {
    const r = classifyAuthSurfaceFault(1, "Error: spawn codex ENOENT");
    assert.equal(r.classification, "real-unavailable");
    assert.equal(r.mayFallback, true);
  });

  it("C2: network errnos (ENOTFOUND/ETIMEDOUT/ECONNREFUSED/EAI_AGAIN) fail closed to sandbox-surface-fault", () => {
    for (const errno of ["ENOTFOUND", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "ENETUNREACH"]) {
      const r = classifyAuthSurfaceFault(1, `request failed: ${errno} api.anthropic.com`);
      assert.equal(r.classification, "sandbox-surface-fault", `${errno} must fail closed`);
      assert.equal(r.mayFallback, false, `${errno} must not enable fallback`);
    }
  });

  it("C2: a network errno on an explicit HOST surface is a host-fault (host evidence present)", () => {
    const r = classifyAuthSurfaceFault(1, "ECONNREFUSED api.anthropic.com", { surface: "host" });
    assert.equal(r.classification, "host-fault");
    assert.equal(r.mayFallback, true);
  });

  it("missing-binary noise COMBINED with sandbox signal stays sandbox-surface-fault (precedence)", () => {
    // A sandbox can emit both; sandbox-limit evidence wins → must not be unavailable.
    const r = classifyAuthSurfaceFault(127, "Not logged in\ncommand not found: gh");
    assert.equal(r.classification, "sandbox-surface-fault");
    assert.equal(r.mayFallback, false);
  });

  it("auth failure explicitly on HOST surface is a host-fault → fallback permitted", () => {
    const r = classifyAuthSurfaceFault(1, "authentication failed", { surface: "host" });
    assert.equal(r.classification, "host-fault");
    assert.equal(r.mayMarkUnavailable, true);
    assert.equal(r.mayFallback, true);
    assert.equal(r.isSandboxFault, false);
  });

  it("Important: explicit HOST surface un-shadows a sandbox-limit string (host-rerun not trapped)", () => {
    // A host rerun whose output happens to echo a sandbox-limit phrase must still be a
    // host-fault (the caller asserted surface=host), so legitimate fallback is permitted.
    const r = classifyAuthSurfaceFault(1, "Not logged in (after host rerun)", { surface: "host" });
    assert.equal(r.classification, "host-fault");
    assert.equal(r.mayFallback, true);
    assert.equal(r.isSandboxFault, false);
  });

  it("Important: a missing binary on an explicit host surface is still real-unavailable", () => {
    const r = classifyAuthSurfaceFault(127, "codex: command not found", { surface: "host" });
    assert.equal(r.classification, "real-unavailable");
    assert.equal(r.mayFallback, true);
  });

  it("fault carrying host-surface evidence markers permits fallback", () => {
    const r = classifyAuthSurfaceFault(1, "host-rerun completed; exit 1; log path /tmp/x.log; require_escalated");
    // host-surface evidence present, no missing binary, no bare sandbox-limit on sandbox surface
    assert.equal(r.mayFallback, true);
  });

  it("exit 0 with no fault signal is ok", () => {
    const r = classifyAuthSurfaceFault(0, "PASS\nverdict: PASS");
    assert.equal(r.classification, "ok");
    assert.equal(r.isSandboxFault, false);
    // ok is not a fallback scenario (no fault to fall back from)
    assert.equal(r.mayFallback, false);
  });

  it("unknown-surface non-zero exit with no recognized signal FAILS CLOSED to sandbox-surface-fault", () => {
    // Hardened (C1): on an unknown surface we cannot prove the error is host-real, so an
    // ambiguous non-zero exit must not enable fallback.
    const r = classifyAuthSurfaceFault(2, "some unexpected reviewer crash stack trace");
    assert.equal(r.classification, "sandbox-surface-fault");
    assert.equal(r.mayFallback, false);
    assert.equal(r.requiresHostRerun, true);
  });

  it("the SAME unrecognized non-zero exit on an explicit HOST surface IS a host-fault", () => {
    const r = classifyAuthSurfaceFault(2, "some unexpected reviewer crash stack trace", { surface: "host" });
    assert.equal(r.classification, "host-fault");
    assert.equal(r.mayFallback, true);
  });

  it("isFallbackAllowed is false for sandbox faults, true for real-unavailable / host-fault", () => {
    assert.equal(isFallbackAllowed(1, "Not logged in"), false);
    assert.equal(isFallbackAllowed(0, "apiKeySource:none"), false);
    assert.equal(isFallbackAllowed(127, "codex: command not found"), true);
    assert.equal(isFallbackAllowed(1, "auth failed", { surface: "host" }), true);
  });

  it("reason strings name host-rerun for sandbox faults", () => {
    assert.match(classifyAuthSurfaceFault(1, "Not logged in").reason, /host-rerun|host rerun/);
  });
});
