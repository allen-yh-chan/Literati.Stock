/**
 * Locks issue #2413 advisory follow-ups: CAS lock bounded retry, typed
 * sticky_authority_snapshot_required, orphan probe jitter, TOCTOU docs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

test("F-2945ee6b784c: sidecar lock acquire uses bounded retry/backoff after stale reap", () => {
  const body = read(".devpro/scripts/hooks/lib/review-round-budget.mjs");
  assert.match(body, /SIDECAR_LOCK_ACQUIRE_ATTEMPTS\s*=\s*4/);
  assert.match(body, /SIDECAR_LOCK_RETRY_BACKOFF_MS/);
  assert.match(body, /for \(let attempt = 0; attempt < SIDECAR_LOCK_ACQUIRE_ATTEMPTS/);
  assert.match(body, /reapStaleLocks\(sidecarFile\)/);
});

test("F-a7d411193b52: missing sticky_authority_snapshot uses typed classification", () => {
  const body = read(".devpro/scripts/render-second-review-packet.mjs");
  assert.match(body, /sticky_authority_snapshot_required/);
  assert.match(body, /error\.classification = "sticky_authority_snapshot_required"/);
});

test("Stop no longer scans foreign orphan sidecars; maintenance helper retains bounded probing", () => {
  const hook = read(".devpro/scripts/hooks/post-pr-completion-check.mjs");
  const lib = read(".devpro/scripts/hooks/lib/post-pr-stop-hotpath-cleanup.mjs");
  assert.doesNotMatch(hook, /orphanSidecarProbeIntervalMs|runBudgetedReviewRoundSidecarCleanup/);
  assert.match(lib, /orphanSidecarProbeIntervalMs\(sidecar\.prNumber\)/);
});

test("F-6e2b84fa17d9: evaluateReviewRoundBudget documents lock-free TOCTOU tradeoff", () => {
  const body = read(".devpro/scripts/hooks/lib/review-round-budget.mjs");
  assert.match(body, /F-6e2b84fa17d9/);
  assert.match(body, /outside the CAS lock on purpose/);
  assert.match(body, /recordReviewRoundDispatch.*re-validates/s);
});

test("F-017054516f7e already shipped: archive gate threads --pr into compactness lint", () => {
  const body = read(".devpro/scripts/pre-pr-archive-gate.mjs");
  assert.match(body, /if \(prNumber\) lintArgs\.push\('--pr', prNumber\)/);
});
