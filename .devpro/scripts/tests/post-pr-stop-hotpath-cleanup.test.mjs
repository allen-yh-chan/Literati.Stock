import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { makeTempDir } from "./lib/tmp.mjs";
import { repoPath } from "./lib/repo-root.mjs";
import {
  STOP_HOTPATH_CLEANUP_BUDGET_MS,
  createStopHotpathBudget,
  nextDeadlineBoundTimeoutMs,
  nextSidecarCursorIndex,
  probeTimeoutMs,
  readSidecarCleanupCursor,
  remainingMsUntil,
  rotateSidecarList,
  runBudgetedReviewRoundSidecarCleanup,
  sortReviewRoundSidecars,
} from "../hooks/lib/post-pr-stop-hotpath-cleanup.mjs";

test("createStopHotpathBudget remainingMs shrinks and does not reset", () => {
  const started = 1_000_000;
  const budget = createStopHotpathBudget(1000, started);
  assert.equal(budget.remainingMs(started), 1000);
  assert.equal(budget.remainingMs(started + 400), 600);
  assert.equal(budget.exhausted(started + 1000), true);
  assert.equal(budget.windowMs, 1000);
  assert.ok(STOP_HOTPATH_CLEANUP_BUDGET_MS < 30_000);
});

test("sidecar cursor advances past last attempt not inspected count", async () => {
  const tmp = makeTempDir("sidecar-cursor-");
  try {
    const sidecars = [10, 20, 30, 40].map((pr) => ({
      prNumber: String(pr),
      file: path.join(tmp, `review-round-${pr}.json`),
      mtimeMs: 0,
    }));
    for (const row of sidecars) writeFileSync(row.file, "{}\n");

    const probed = [];
    const budget = {
      exhausted() {
        return probed.length >= 1;
      },
      remainingMs() {
        return probed.length >= 1 ? 0 : 1000;
      },
    };

    const first = await runBudgetedReviewRoundSidecarCleanup({
      sidecars,
      markerPrs: new Set(),
      now: 10_000,
      budget,
      cursorDir: tmp,
      orphanSidecarProbeIntervalMs: () => 0,
      async probeSidecar(sidecar) {
        probed.push(sidecar.prNumber);
        return { cleared: false };
      },
    });
    assert.deepEqual(probed, ["10"]);
    assert.equal(first.nextIndex, 1);
    assert.equal(readSidecarCleanupCursor(tmp), 1);

    const probed2 = [];
    const budget2 = {
      exhausted() {
        return probed2.length >= 1;
      },
      remainingMs() {
        return probed2.length >= 1 ? 0 : 1000;
      },
    };
    const second = await runBudgetedReviewRoundSidecarCleanup({
      sidecars,
      markerPrs: new Set(),
      now: 20_000,
      budget: budget2,
      cursorDir: tmp,
      orphanSidecarProbeIntervalMs: () => 0,
      async probeSidecar(sidecar) {
        probed2.push(sidecar.prNumber);
        return { cleared: false };
      },
    });
    assert.deepEqual(probed2, ["20"], "cursor must start after retained prefix");
    assert.equal(second.nextIndex, 2);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("retained sidecar prefix cannot starve later entries across repeated budgeted runs", async () => {
  const tmp = makeTempDir("sidecar-starve-");
  try {
    const sidecars = [1, 2, 3, 4].map((pr) => ({
      prNumber: String(pr),
      file: path.join(tmp, `review-round-${pr}.json`),
      mtimeMs: 0,
    }));
    for (const row of sidecars) writeFileSync(row.file, "{}\n");
    const seen = new Set();
    for (let round = 0; round < 4; round += 1) {
      let attempts = 0;
      await runBudgetedReviewRoundSidecarCleanup({
        sidecars,
        markerPrs: new Set(),
        now: 30_000 + round,
        budget: {
          exhausted() {
            return attempts >= 1;
          },
        },
        cursorDir: tmp,
        orphanSidecarProbeIntervalMs: () => 0,
        async probeSidecar(sidecar) {
          attempts += 1;
          seen.add(sidecar.prNumber);
          return { cleared: false };
        },
      });
    }
    assert.deepEqual([...seen].sort(), ["1", "2", "3", "4"]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("rotate and nextSidecarCursorIndex helpers are deterministic", () => {
  const rows = sortReviewRoundSidecars([
    { prNumber: "30" },
    { prNumber: "10" },
    { prNumber: "20" },
  ]);
  assert.deepEqual(rows.map((r) => r.prNumber), ["10", "20", "30"]);
  assert.deepEqual(
    rotateSidecarList(rows, 1).map((r) => r.prNumber),
    ["20", "30", "10"],
  );
  assert.equal(
    nextSidecarCursorIndex({ sidecars: rows, lastAttemptedPrNumber: "20", startIndex: 0 }),
    2,
  );
});

test("Stop inventory never prunes global marker state", () => {
  const source = readFileSync(repoPath(".devpro/scripts/hooks/post-pr-completion-check.mjs"), "utf8");
  const state = readFileSync(repoPath(".devpro/scripts/hooks/lib/post-pr-completion-state.mjs"), "utf8");
  assert.match(source, /listOwnedPostPrStopMarkers\(cwd, reminderSession/);
  assert.match(state, /listPostPrCompletionMarkers\(cwd, Date\.now\(\), \{ pruneStale: false \}\)/);
  assert.doesNotMatch(
    source,
    /runBudgetedReviewRoundSidecarCleanup|pruneExpiredSecondReviewControlEvidence/,
    "Stop must not become a global cleanup owner",
  );
});

test("Stop selects session ownership without foreign cleanup probes", () => {
  const source = readFileSync(repoPath(".devpro/scripts/hooks/post-pr-completion-check.mjs"), "utf8");
  const state = readFileSync(repoPath(".devpro/scripts/hooks/lib/post-pr-completion-state.mjs"), "utf8");
  assert.match(source, /listOwnedPostPrStopMarkers\(cwd, reminderSession/);
  assert.match(state, /\.filter\(\(marker\) => ownsPostPrCompletionMarker\(marker, session\)\)/);
  assert.doesNotMatch(source, /cleanupMergedSkippedMarker|skippedCleanupProofSignature/);
});

test("probeTimeoutMs caps each probe by remaining wallet", () => {
  const budget = createStopHotpathBudget(80, 1_000_000);
  assert.equal(probeTimeoutMs(budget, { maxMs: 5000, at: 1_000_000 }), 80);
  assert.equal(probeTimeoutMs(budget, { maxMs: 5000, at: 1_000_060 }), 20);
  assert.equal(probeTimeoutMs(budget, { maxMs: 5000, at: 1_000_080 }), 0);
  assert.equal(probeTimeoutMs(null, { maxMs: 5000 }), 5000);
});

test("slow probe receives remaining timeout and later phases see exhausted wallet", async () => {
  const tmp = makeTempDir("sidecar-timeout-");
  try {
    const sidecars = [1, 2].map((pr) => ({
      prNumber: String(pr),
      file: path.join(tmp, `review-round-${pr}.json`),
      mtimeMs: 0,
    }));
    for (const row of sidecars) writeFileSync(row.file, "{}\n");
    const started = Date.now();
    const budget = createStopHotpathBudget(40, started);
    const timeouts = [];
    const first = await runBudgetedReviewRoundSidecarCleanup({
      sidecars,
      markerPrs: new Set(),
      now: started,
      budget,
      cursorDir: tmp,
      orphanSidecarProbeIntervalMs: () => 0,
      async probeSidecar(_sidecar, { timeoutMs }) {
        timeouts.push(timeoutMs);
        // Simulate a probe that consumes the whole remaining slice.
        const waitUntil = Date.now() + timeoutMs;
        while (Date.now() < waitUntil) {
          /* busy-wait within the declared timeout */
        }
        return { cleared: false };
      },
    });
    assert.equal(timeouts.length, 1);
    assert.ok(timeouts[0] > 0 && timeouts[0] <= 40);
    assert.equal(first.attempted, 1);
    assert.equal(budget.exhausted(), true, "in-flight probe must consume the shared wallet");
    assert.equal(
      budget.remainingMs(),
      0,
      "later cleanup phases must see an exhausted wallet after a bounded probe",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("two-fetch snapshot path recomputes remaining after a delayed light fetch", () => {
  const deadline = 1_000_000 + 2500;
  // After a 2000ms light fetch, only ~500ms may remain — not budgetedTimeout-1.
  assert.equal(remainingMsUntil(deadline, 1_000_000), 2500);
  assert.equal(remainingMsUntil(deadline, 1_002_000), 500);
  assert.equal(
    nextDeadlineBoundTimeoutMs({ deadline, now: 1_002_000, minMs: 50 }),
    500,
  );
  assert.equal(
    nextDeadlineBoundTimeoutMs({ deadline, now: 1_002_460, minMs: 50 }),
    0,
    "full fetch must be skipped when remaining is below minMs",
  );
  const source = readFileSync(repoPath(".devpro/scripts/hooks/post-pr-completion-check.mjs"), "utf8");
  assert.match(source, /nextDeadlineBoundTimeoutMs\(\{\s*deadline/);
  assert.doesNotMatch(source, /budgetedTimeout\s*-\s*1/);
});
