import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PR_STICKY_REVIEW_ROUND_CAP,
  assertReviewRoundBudget,
  clearReviewRoundState,
  evaluateReviewRoundBudget,
  listReviewRoundSidecars,
  parseReviewRoundOverride,
  readReviewRoundState,
  recordReviewRoundDispatch,
  reviewRoundSidecarPath,
} from "../hooks/lib/review-round-budget.mjs";
import { makeTempDir } from "./lib/tmp.mjs";

// D11(c) fault-recovery fixture (round_count stays at 2 across a fault-recovery
// re-dispatch; only the lineage grows). See fixtures/loop-termination/README.md
// for the fixture-set-wide SHA provenance note this file's placeholder mirrors.
const faultRecoveryFixture = JSON.parse(readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "fixtures/loop-termination/round-budget-fault-recovery.json",
  ),
  "utf8",
));

function withStateDir(fn) {
  const dir = makeTempDir("devpro-review-round-budget-");
  const previous = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (previous === undefined) delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
    else process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = previous;
  }
}

function deadPid() {
  const result = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(Number.isInteger(result.pid), "spawnSync should expose child pid");
  return result.pid;
}

function seedSidecar(prNumber, roundCount, extra = {}) {
  const file = reviewRoundSidecarPath({ prNumber });
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({
    schema_version: 1,
    pr_number: String(prNumber),
    repository_slug: "devpro/example",
    round_count: roundCount,
    dispatch_lineage: Array.from({ length: roundCount }, (_unused, index) => ({
      round: index + 1,
      kind: "initial",
      attempt: "initial",
      dispatch_id: `dispatch-seed-${index + 1}`,
      head_ref_oid: "a".repeat(40),
      review_scope: "full-pr",
      recorded_at: new Date(0).toISOString(),
    })),
    updated_at: new Date(0).toISOString(),
    ...extra,
  }, null, 2));
  return file;
}

const exhaustedMessage = (prNumber, roundCount) => (
  `pr-sticky lane round budget (cap ${PR_STICKY_REVIEW_ROUND_CAP}) exhausted for PR #${prNumber} `
  + `(round_count=${roundCount}). Extend only with named user authorization: `
  + `DEVPRO_REVIEW_ROUND_OVERRIDE=${prNumber}:<n> where n > ${roundCount}. This cap belongs to the `
  + "pr-sticky lane and MUST NOT be merged with the audit-only lane cap (6) or the harness write-block cap (3)."
  + " Target repository is github.com/devpro/example. To limit the authorization to this repository, use "
  + `DEVPRO_REVIEW_ROUND_OVERRIDE=github.com/devpro/example#${prNumber}:<n>.`
);

test("same PR number has independent review caps and cleanup per repository", () => {
  withStateDir(() => {
    const a = { prNumber: "42", repositorySlug: "fixture/repo-a" };
    const b = { prNumber: "42", repositorySlug: "github.com/FIXTURE/Repo-B" };
    for (let round = 0; round < PR_STICKY_REVIEW_ROUND_CAP; round++) {
      assertReviewRoundBudget({ ...a, attempt: "initial", env: {} });
    }
    assert.throws(() => evaluateReviewRoundBudget({ ...a, attempt: "initial", env: {} }),
      { classification: "review_round_budget_exhausted" });
    assert.equal(assertReviewRoundBudget({ ...b, attempt: "initial", env: {} }).round_count, 1);
    const aFile = reviewRoundSidecarPath(a);
    const bFile = reviewRoundSidecarPath(b);
    assert.notEqual(aFile, bFile);
    assert.deepEqual(listReviewRoundSidecars().map(({ prNumber, file }) => ({ prNumber, file })).sort((a, b) => a.file.localeCompare(b.file)),
      [aFile, bFile].sort((a, b) => a.localeCompare(b)).map(file => ({ prNumber: "42", file })));
    assert.equal(clearReviewRoundState(b), true);
    assert.equal(existsSync(bFile), false);
    assert.equal(readReviewRoundState(a).round_count, 3);
    assert.equal(existsSync(aFile), true);
  });
});

test("a proven legacy sidecar retains its complete lineage and page continuity", () => {
  withStateDir(() => {
    const prNumber = "42";
    const repositorySlug = "devpro/example";
    const headRefOid = "a".repeat(40);
    const file = seedSidecar(prNumber, 3);
    const original = JSON.parse(readFileSync(file, "utf8"));
    original.dispatch_lineage[2].page_window_index = 1;
    writeFileSync(file, JSON.stringify(original));
    const continued = assertReviewRoundBudget({
      prNumber, repositorySlug, headRefOid, attempt: "page-window-continue", env: {},
      pageWindowHandoff: { page_window_checkpoint_handoff: true, head_ref_oid: headRefOid, window_index: 2 },
    });
    assert.equal(continued.round_count, 3);
    assert.deepEqual(continued.dispatch_lineage.slice(0, 3), original.dispatch_lineage);
    assert.equal(continued.dispatch_lineage[3].page_window_index, 2);
    assert.equal(readReviewRoundState({ prNumber, repositorySlug }).round_count, 3);
    assert.equal(clearReviewRoundState({ prNumber, repositorySlug: "fixture/elsewhere" }), false);
    assert.equal(existsSync(file), true);
  });
});

test("scoped state refuses an unowned or duplicate sidecar and keeps both files intact", () => {
  for (const duplicate of [false, true]) withStateDir(() => {
    const scoped = { prNumber: "42", repositorySlug: "devpro/example" };
    const keyed = reviewRoundSidecarPath(scoped);
    if (duplicate) recordReviewRoundDispatch({ ...scoped, attempt: "initial" });
    const legacy = seedSidecar(scoped.prNumber, 2, duplicate ? {} : { repository_slug: "" });
    const legacyBytes = readFileSync(legacy);
    const keyedBytes = duplicate ? readFileSync(keyed) : null;
    const error = { classification: "review_round_state_identity_conflict" };
    assert.throws(() => readReviewRoundState(scoped), error);
    assert.throws(() => recordReviewRoundDispatch({ ...scoped, attempt: "initial" }), error);
    assert.throws(() => clearReviewRoundState(scoped), error);
    assert.deepEqual(readFileSync(legacy), legacyBytes);
    if (duplicate) assert.deepEqual(readFileSync(keyed), keyedBytes);
    else assert.equal(existsSync(keyed), false);
    assert.equal(readReviewRoundState({ prNumber: scoped.prNumber }).round_count, 2);
  });
});

test("a keyed round sidecar must agree with its repository and PR payload", () => {
  withStateDir(() => {
    const target = { prNumber: "42", repositorySlug: "fixture/repo-a" };
    const file = reviewRoundSidecarPath(target);
    recordReviewRoundDispatch({ ...target, attempt: "initial" });
    const state = JSON.parse(readFileSync(file, "utf8"));
    for (const invalid of [{ repository_slug: "fixture/repo-b" }, { pr_number: "43" }]) {
      const bytes = JSON.stringify({ ...state, ...invalid });
      writeFileSync(file, bytes);
      assert.throws(() => readReviewRoundState(target), { classification: "review_round_state_identity_conflict" });
      assert.throws(() => clearReviewRoundState(target), { classification: "review_round_state_identity_conflict" });
      assert.equal(readFileSync(file, "utf8"), bytes);
    }
    assert.throws(() => readReviewRoundState({ prNumber: "42", repositorySlug: "enterprise.invalid/fixture/repo-a" }),
      { classification: "review_round_state_identity_conflict" });
  });
});

test("a qualified override can extend only its repository and PR", () => {
  const input = { prNumber: "42", roundCount: 3 };
  const first = parseReviewRoundOverride("Fixture/Repo-A#42:5", { ...input, repositorySlug: "github.com/fixture/repo-a" });
  assert.equal(first.authorized, true);
  assert.equal(first.override_repo, "github.com/fixture/repo-a");
  assert.equal(parseReviewRoundOverride("fixture/repo-a#42:5", { ...input, repositorySlug: "fixture/repo-b" }).authorized, false);
  assert.equal(parseReviewRoundOverride("fixture/repo-a#42:5", input).authorized, false);
  assert.equal(parseReviewRoundOverride("ghe.fixture.invalid/fixture/repo-a#42:5", { ...input, repositorySlug: "fixture/repo-a" }).authorized, false);
  assert.equal(parseReviewRoundOverride("42:5", { ...input, repositorySlug: "fixture/repo-b" }).authorized, true);
  withStateDir(() => {
    const a = { prNumber: "42", repositorySlug: "fixture/repo-a", attempt: "initial" };
    const b = { ...a, repositorySlug: "fixture/repo-b" };
    for (let round = 0; round < PR_STICKY_REVIEW_ROUND_CAP; round++) {
      recordReviewRoundDispatch(a);
      recordReviewRoundDispatch(b);
    }
    const env = { DEVPRO_REVIEW_ROUND_OVERRIDE: "fixture/repo-a#42:5" };
    assert.throws(() => assertReviewRoundBudget({ ...b, env }), { classification: "review_round_budget_exhausted" });
    const accepted = assertReviewRoundBudget({ ...a, env });
    assert.deepEqual(accepted.dispatch_lineage.at(-1).override, {
      override_pr: "42", override_max: 5, observed_round_count: 3, override_repo: "github.com/fixture/repo-a",
    });
    assert.throws(() => recordReviewRoundDispatch({ ...b, override: accepted.override }),
      { classification: "review_round_budget_exhausted" });
    assert.equal(readReviewRoundState(b).round_count, 3);
  });
});

test("cap hit blocks a fresh initial dispatch with zero sidecar mutation", () => {
  withStateDir(() => {
    const prNumber = "2407";
    const file = seedSidecar(prNumber, PR_STICKY_REVIEW_ROUND_CAP);
    const before = readFileSync(file, "utf8");
    let thrown = null;
    try {
      assertReviewRoundBudget({ prNumber, attempt: "initial", repositorySlug: "devpro/example" });
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown, "expected assertReviewRoundBudget to throw");
    assert.equal(thrown.classification, "review_round_budget_exhausted");
    assert.equal(thrown.message, exhaustedMessage(prNumber, PR_STICKY_REVIEW_ROUND_CAP));
    // Zero packet artifact: the throw precedes the record, so the sidecar
    // MUST be byte-identical to its pre-call state (no round burned on a
    // rejected dispatch).
    assert.equal(readFileSync(file, "utf8"), before);
  });
});

test("cap hit blocks a fresh focused-sticky-refresh dispatch with zero sidecar mutation", () => {
  withStateDir(() => {
    const prNumber = "2408";
    const file = seedSidecar(prNumber, PR_STICKY_REVIEW_ROUND_CAP);
    const before = readFileSync(file, "utf8");
    let thrown = null;
    try {
      assertReviewRoundBudget({
        prNumber,
        attempt: "focused-sticky-refresh",
        repositorySlug: "devpro/example",
      });
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown, "expected assertReviewRoundBudget to throw");
    assert.equal(thrown.classification, "review_round_budget_exhausted");
    assert.equal(thrown.message, exhaustedMessage(prNumber, PR_STICKY_REVIEW_ROUND_CAP));
    assert.equal(readFileSync(file, "utf8"), before);
  });
});

test("override missing fails closed", () => {
  const result = parseReviewRoundOverride(undefined, { prNumber: "2407", roundCount: 3 });
  assert.deepEqual(result, { authorized: false, reason: "missing" });
  assert.deepEqual(
    parseReviewRoundOverride("", { prNumber: "2407", roundCount: 3 }),
    { authorized: false, reason: "missing" },
  );
});

test("override malformed fails closed (hash prefix, comma-separated, internal whitespace)", () => {
  for (const raw of ["#2407:4", "2407:4,2407:5", "2407: 4", "2407:4:5"]) {
    const result = parseReviewRoundOverride(raw, { prNumber: "2407", roundCount: 3 });
    assert.equal(result.authorized, false, `expected ${JSON.stringify(raw)} to fail closed`);
    assert.equal(result.reason, "malformed", `expected ${JSON.stringify(raw)} to be malformed`);
  }
});

test("override PR# mismatch fails closed", () => {
  const result = parseReviewRoundOverride("9999:4", { prNumber: "2407", roundCount: 3 });
  assert.equal(result.authorized, false);
  assert.equal(result.reason, "pr_mismatch");
});

test("override n <= round_count is treated as unauthorized (D5 tightening clause)", () => {
  const atCap = parseReviewRoundOverride("2407:3", { prNumber: "2407", roundCount: 3 });
  assert.equal(atCap.authorized, false);
  assert.equal(atCap.reason, "not_greater_than_round_count");
  const below = parseReviewRoundOverride("2407:2", { prNumber: "2407", roundCount: 3 });
  assert.equal(below.authorized, false);
  assert.equal(below.reason, "not_greater_than_round_count");
});

test("a valid, PR-matched, strictly-greater override authorizes and stamps an audit trail", () => {
  withStateDir(() => {
    const prNumber = "2407";
    seedSidecar(prNumber, PR_STICKY_REVIEW_ROUND_CAP);
    const result = assertReviewRoundBudget({
      prNumber,
      attempt: "initial",
      repositorySlug: "devpro/example",
      dispatchId: "dispatch-override-test",
      headRefOid: "b".repeat(40),
      reviewScope: "full-pr",
      env: { DEVPRO_REVIEW_ROUND_OVERRIDE: "2407:4" },
    });
    assert.equal(result.round_count, PR_STICKY_REVIEW_ROUND_CAP + 1);
    assert.deepEqual(result.override, {
      override_pr: "2407",
      override_max: 4,
      observed_round_count: PR_STICKY_REVIEW_ROUND_CAP,
    });
    const state = readReviewRoundState({ prNumber });
    assert.equal(state.round_count, PR_STICKY_REVIEW_ROUND_CAP + 1);
    const lastEntry = state.dispatch_lineage.at(-1);
    assert.equal(lastEntry.kind, "initial");
    assert.deepEqual(lastEntry.override, {
      override_pr: "2407",
      override_max: 4,
      observed_round_count: PR_STICKY_REVIEW_ROUND_CAP,
    });
  });
});

test("fault-recovery attempt does not increment round_count but appends a lineage entry", () => {
  withStateDir(() => {
    const prNumber = String(faultRecoveryFixture.sidecar.pr_number);
    seedSidecar(prNumber, faultRecoveryFixture.sidecar.round_count);
    const result = assertReviewRoundBudget({
      prNumber,
      attempt: faultRecoveryFixture.handoff.attempt,
      repositorySlug: "devpro/example",
      dispatchId: "dispatch-fault-recovery-test",
      headRefOid: "c".repeat(40),
      reviewScope: "full-pr",
    });
    assert.equal(faultRecoveryFixture.handoff.attempt, "fault-recovery");
    assert.equal(result.round_count, faultRecoveryFixture.sidecar.round_count);
    const lastEntry = result.dispatch_lineage.at(-1);
    assert.equal(lastEntry.kind, "fault-recovery");
    assert.equal(lastEntry.round, faultRecoveryFixture.sidecar.round_count);
  });
});

test("sidecar write failure classifies review_round_state_write_failed (lock already held)", () => {
  withStateDir(() => {
    const prNumber = "2409";
    const file = reviewRoundSidecarPath({ prNumber });
    mkdirSync(path.dirname(file), { recursive: true });
    // Simulate a concurrent writer already holding a live (per-attempt
    // unique-named) lock: any fresh `<sidecar>.lock.<token>` file blocks,
    // regardless of the exact token — lock filenames are unique per attempt
    // (F4 fix), so this does not need to match a real acquirer's own UUID.
    writeFileSync(`${file}.lock.simulated-concurrent-writer`, JSON.stringify({
      schema: "devpro-review-round-sidecar-lock/v1",
      owner_pid: process.pid,
      created_at: new Date().toISOString(),
    }));
    let thrown = null;
    try {
      recordReviewRoundDispatch({
        prNumber,
        attempt: "initial",
        repositorySlug: "devpro/example",
        dispatchId: "dispatch-lock-busy",
        headRefOid: "d".repeat(40),
        reviewScope: "full-pr",
      });
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown, "expected recordReviewRoundDispatch to throw on lock contention");
    assert.equal(thrown.classification, "review_round_state_write_failed");
    assert.equal(existsSync(file), false, "sidecar MUST NOT be written when the write failed");
  });
});

test("F3: a losing concurrent dispatch cannot push round_count past the cap (TOCTOU close)", () => {
  withStateDir(() => {
    const prNumber = "2411";
    // Both racers' lock-free evaluate() ran while round_count was still 2
    // (cap 3, so neither saw itself exhausted and neither authorized an
    // override) — this is the exact stale snapshot the original TOCTOU let
    // through unchecked at record time.
    const file = seedSidecar(prNumber, PR_STICKY_REVIEW_ROUND_CAP - 1);

    const winner = recordReviewRoundDispatch({
      prNumber,
      attempt: "initial",
      repositorySlug: "devpro/example",
      dispatchId: "dispatch-race-winner",
      headRefOid: "b".repeat(40),
      reviewScope: "full-pr",
      override: null,
    });
    assert.equal(winner.round_count, PR_STICKY_REVIEW_ROUND_CAP, "winner takes the last round under the cap");
    const afterWinner = readFileSync(file, "utf8");

    let thrown = null;
    try {
      recordReviewRoundDispatch({
        prNumber,
        attempt: "initial",
        repositorySlug: "devpro/example",
        dispatchId: "dispatch-race-loser",
        headRefOid: "c".repeat(40),
        reviewScope: "full-pr",
        override: null,
      });
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown, "expected the second (post-cap) record to fail closed instead of writing round 4");
    assert.equal(thrown.classification, "review_round_budget_exhausted");
    // The fresh round_count under the lock is 3 (the winner's write), not
    // the stale 2 either racer's earlier evaluate() saw — the mandated
    // message MUST report that fresh value, not the stale one.
    assert.equal(thrown.message, exhaustedMessage(prNumber, PR_STICKY_REVIEW_ROUND_CAP));
    // Zero mutation: the rejected loser must not have touched the sidecar
    // the winner already wrote.
    assert.equal(readFileSync(file, "utf8"), afterWinner);
  });
});

test("F3: a valid override still authorizes the losing racer up to its own max", () => {
  withStateDir(() => {
    const prNumber = "24110";
    const file = seedSidecar(prNumber, PR_STICKY_REVIEW_ROUND_CAP);
    // Both racers' evaluate() authorized against the same override (max=5,
    // observed round_count=3): the winner consumes round 4, and the loser
    // — re-validated fresh at record time against the winner's round_count
    // 4 — must still succeed because 5 > 4.
    const override = { override_pr: prNumber, override_max: 5, observed_round_count: PR_STICKY_REVIEW_ROUND_CAP };

    const winner = recordReviewRoundDispatch({
      prNumber,
      attempt: "initial",
      repositorySlug: "devpro/example",
      dispatchId: "dispatch-override-winner",
      headRefOid: "b".repeat(40),
      reviewScope: "full-pr",
      override,
    });
    assert.equal(winner.round_count, 4);

    const loser = recordReviewRoundDispatch({
      prNumber,
      attempt: "initial",
      repositorySlug: "devpro/example",
      dispatchId: "dispatch-override-loser",
      headRefOid: "c".repeat(40),
      reviewScope: "full-pr",
      override,
    });
    assert.equal(loser.round_count, 5, "override_max=5 still authorizes one more round at fresh round_count=4");

    // A third contender under the SAME override must now fail closed: fresh
    // round_count is 5, and 5 > 5 is false.
    let thrown = null;
    try {
      recordReviewRoundDispatch({
        prNumber,
        attempt: "initial",
        repositorySlug: "devpro/example",
        dispatchId: "dispatch-override-third",
        headRefOid: "d".repeat(40),
        reviewScope: "full-pr",
        override,
      });
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown, "override_max is a hard ceiling regardless of how many racers share it");
    assert.equal(thrown.classification, "review_round_budget_exhausted");
    assert.equal(thrown.message, exhaustedMessage(prNumber, 5));
  });
});

test("F4: reaping a stale lock cannot remove a concurrent fresh contender's lock (replacement race closed)", () => {
  withStateDir(() => {
    const prNumber = "2412";
    const file = seedSidecar(prNumber, 1);
    mkdirSync(path.dirname(file), { recursive: true });

    // A genuinely stale-and-dead lock: mtime well past the 30s stale
    // window, owner PID no longer alive.
    const staleLockFile = `${file}.lock.stale-dead-owner`;
    writeFileSync(staleLockFile, JSON.stringify({
      schema: "devpro-review-round-sidecar-lock/v1",
      owner_pid: deadPid(),
      created_at: new Date(0).toISOString(),
    }));
    const oldTimeSeconds = (Date.now() - 60_000) / 1000;
    utimesSync(staleLockFile, oldTimeSeconds, oldTimeSeconds);

    // A genuinely fresh, live contender's lock — this test process's own
    // pid, which is alive for the duration of the test.
    const freshLockFile = `${file}.lock.fresh-live-owner`;
    writeFileSync(freshLockFile, JSON.stringify({
      schema: "devpro-review-round-sidecar-lock/v1",
      owner_pid: process.pid,
      created_at: new Date().toISOString(),
    }));

    let thrown = null;
    try {
      recordReviewRoundDispatch({
        prNumber,
        attempt: "initial",
        repositorySlug: "devpro/example",
        dispatchId: "dispatch-replacement-race",
        headRefOid: "d".repeat(40),
        reviewScope: "full-pr",
      });
    } catch (error) {
      thrown = error;
    }
    // The genuinely stale lock is reaped by its own unique path…
    assert.equal(existsSync(staleLockFile), false, "the genuinely stale lock is reaped");
    // …but the fresh contender's lock, at a DIFFERENT unique path, must
    // survive untouched. This is the replacement-race property: a reap that
    // only ever unlinks the exact file it verified stale can never remove a
    // live contender's lock, because the two can no longer share a path.
    assert.equal(existsSync(freshLockFile), true, "the fresh contender's lock survives the reap");
    // This dispatch must back off (fail closed) rather than proceed
    // concurrently alongside the live contender.
    assert.ok(thrown, "expected this dispatch to back off behind the live contender's lock");
    assert.equal(thrown.classification, "review_round_state_write_failed");
  });
});

test("otherLiveLockExists treats an old-but-live holder as contention (owner-liveness gap closed)", () => {
  withStateDir(() => {
    const prNumber = "2413";
    const file = seedSidecar(prNumber, 1);

    // Aged well past the 30s staleness window, but the owner is this test
    // process itself — genuinely still alive and (by hypothesis) still
    // inside its critical section. reapStaleLocks correctly leaves this
    // alone (owner-aware); a second acquirer's otherLiveLockExists scan
    // MUST still treat it as contention rather than reading its age alone.
    const oldLiveLockFile = `${file}.lock.old-but-live-owner`;
    writeFileSync(oldLiveLockFile, JSON.stringify({
      schema: "devpro-review-round-sidecar-lock/v1",
      owner_pid: process.pid,
      created_at: new Date(0).toISOString(),
    }));
    const oldTimeSeconds = (Date.now() - 60_000) / 1000;
    utimesSync(oldLiveLockFile, oldTimeSeconds, oldTimeSeconds);

    let thrown = null;
    try {
      recordReviewRoundDispatch({
        prNumber,
        attempt: "initial",
        repositorySlug: "devpro/example",
        dispatchId: "dispatch-old-live-holder",
        headRefOid: "e".repeat(40),
        reviewScope: "full-pr",
      });
    } catch (error) {
      thrown = error;
    }
    // The old-but-live lock is not reaped (owner alive) …
    assert.equal(existsSync(oldLiveLockFile), true, "an aged lock with a live owner is not reaped");
    // … and MUST still block a concurrent acquirer instead of being read as
    // absent purely because it is past the staleness window.
    assert.ok(thrown, "expected this dispatch to back off behind the old-but-live holder");
    assert.equal(thrown.classification, "review_round_state_write_failed");
  });
});

test("otherLiveLockExists fails closed when the lock directory cannot be listed (inventory failure)", { skip: process.platform === "win32" }, () => {
  withStateDir((dir) => {
    const prNumber = "24140";
    chmodSync(dir, 0o300);
    try {
      let thrown = null;
      try {
        recordReviewRoundDispatch({
          prNumber,
          attempt: "initial",
          repositorySlug: "devpro/example",
          dispatchId: "dispatch-inventory-failure",
          headRefOid: "f".repeat(40),
          reviewScope: "full-pr",
        });
      } catch (error) {
        thrown = error;
      }
      // Write+execute-but-not-readable: entries can still be created by
      // known name (own lock file) but readdirSync — the inventory
      // otherLiveLockExists depends on — MUST fail. Ambiguous evidence about
      // "is anyone else holding a lock" MUST resolve to contention, not to
      // a silent proceed.
      assert.ok(thrown, "expected an unreadable lock directory to fail closed rather than proceed");
      assert.equal(thrown.classification, "review_round_state_write_failed");
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});

test("sidecar write failure classifies review_round_state_write_failed (unwritable state dir)", { skip: process.platform === "win32" }, () => {
  withStateDir((dir) => {
    const prNumber = "2410";
    chmodSync(dir, 0o500);
    try {
      let thrown = null;
      try {
        recordReviewRoundDispatch({
          prNumber,
          attempt: "initial",
          repositorySlug: "devpro/example",
          dispatchId: "dispatch-unwritable-dir",
          headRefOid: "e".repeat(40),
          reviewScope: "full-pr",
        });
      } catch (error) {
        thrown = error;
      }
      assert.ok(thrown, "expected recordReviewRoundDispatch to throw when the state dir is unwritable");
      assert.equal(thrown.classification, "review_round_state_write_failed");
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});

test("N3: a missing sidecar reads as round_count 0 and upgrades in place on first write", () => {
  withStateDir(() => {
    const prNumber = "2411";
    const before = readReviewRoundState({ prNumber });
    assert.equal(before.round_count, 0);
    assert.equal(before.exists, false);
    const result = assertReviewRoundBudget({
      prNumber,
      attempt: "initial",
      repositorySlug: "devpro/example",
      dispatchId: "dispatch-upgrade-test",
      headRefOid: "f".repeat(40),
      reviewScope: "full-pr",
    });
    assert.equal(result.round_count, 1);
    const lastEntry = result.dispatch_lineage.at(-1);
    assert.equal(lastEntry.provenance, "upgraded-from-missing");
  });
});

test("clearReviewRoundState durably removes the sidecar", () => {
  withStateDir(() => {
    const prNumber = "2412";
    const file = seedSidecar(prNumber, 1);
    assert.equal(existsSync(file), true);
    assert.equal(clearReviewRoundState({ prNumber }), true);
    assert.equal(existsSync(file), false);
    assert.equal(clearReviewRoundState({ prNumber }), false);
  });
});

test("R3: page-window continues do not increment round_count; 4th counting attempt still exhausts", () => {
  withStateDir(() => {
    const prNumber = "2801";
    const head = "a".repeat(40);
    const initial = assertReviewRoundBudget({
      prNumber,
      attempt: "initial",
      repositorySlug: "devpro/example",
      dispatchId: "dispatch-pw-initial",
      headRefOid: head,
      reviewScope: "full-pr",
      pageWindowHandoff: {
        page_window_checkpoint_handoff: true,
        head_ref_oid: head,
        window_index: 1,
      },
    });
    assert.equal(initial.round_count, 1);
    assert.equal(initial.dispatch_lineage.at(-1).page_window_index, 1);

    for (const windowIndex of [2, 3, 4, 5]) {
      const cont = assertReviewRoundBudget({
        prNumber,
        attempt: "initial",
        repositorySlug: "devpro/example",
        dispatchId: `dispatch-pw-continue-${windowIndex}`,
        headRefOid: head,
        reviewScope: "full-pr",
        pageWindowHandoff: {
          page_window_checkpoint_handoff: true,
          head_ref_oid: head,
          window_index: windowIndex,
        },
      });
      assert.equal(cont.round_count, 1, `continue window ${windowIndex} must not increment`);
      assert.equal(cont.dispatch_lineage.at(-1).kind, "page-window-continue");
    }

    assertReviewRoundBudget({
      prNumber,
      attempt: "focused-sticky-refresh",
      repositorySlug: "devpro/example",
      dispatchId: "dispatch-pw-focus-2",
      headRefOid: head,
      reviewScope: "full-pr",
    });
    assertReviewRoundBudget({
      prNumber,
      attempt: "focused-sticky-refresh",
      repositorySlug: "devpro/example",
      dispatchId: "dispatch-pw-focus-3",
      headRefOid: head,
      reviewScope: "full-pr",
    });
    assert.equal(readReviewRoundState({ prNumber, repositorySlug: "devpro/example" }).round_count, 3);

    let thrown = null;
    try {
      assertReviewRoundBudget({
        prNumber,
        attempt: "initial",
        repositorySlug: "devpro/example",
        dispatchId: "dispatch-pw-focus-4",
        headRefOid: head,
        reviewScope: "full-pr",
      });
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown, "4th counting attempt must exhaust");
    assert.equal(thrown.classification, "review_round_budget_exhausted");
    assert.equal(PR_STICKY_REVIEW_ROUND_CAP, 3);
  });
});

test("R3 negative: fake page-window-continue without checkpoint still counts", () => {
  withStateDir(() => {
    const prNumber = "2802";
    const head = "b".repeat(40);
    seedSidecar(prNumber, 1, { headRefOid: head });
    // Force a same-head prior lineage entry without page_window proof surface.
    const file = reviewRoundSidecarPath({ prNumber });
    const raw = JSON.parse(readFileSync(file, "utf8"));
    raw.dispatch_lineage = [{
      round: 1,
      kind: "initial",
      attempt: "initial",
      dispatch_id: "prior",
      head_ref_oid: head,
      review_scope: "full-pr",
      recorded_at: new Date().toISOString(),
    }];
    writeFileSync(file, JSON.stringify(raw));

    const fake = assertReviewRoundBudget({
      prNumber,
      attempt: "page-window-continue",
      repositorySlug: "devpro/example",
      dispatchId: "dispatch-fake-continue",
      headRefOid: head,
      reviewScope: "full-pr",
    });
    assert.equal(fake.round_count, 2, "unproven continue MUST still count");
    assert.equal(fake.dispatch_lineage.at(-1).kind, "initial");
    assert.equal(fake.dispatch_lineage.at(-1).fake_continue_coerced, true);
  });
});

test("R3 negative: mislabeled continue without checkpoint handoff still counts", () => {
  withStateDir(() => {
    const prNumber = "2803";
    const head = "c".repeat(40);
    assertReviewRoundBudget({
      prNumber,
      attempt: "initial",
      repositorySlug: "devpro/example",
      dispatchId: "dispatch-base",
      headRefOid: head,
      reviewScope: "full-pr",
      pageWindowHandoff: {
        page_window_checkpoint_handoff: true,
        head_ref_oid: head,
        window_index: 1,
      },
    });
    const fake = assertReviewRoundBudget({
      prNumber,
      attempt: "page-window-continue",
      repositorySlug: "devpro/example",
      dispatchId: "dispatch-mislabeled",
      headRefOid: head,
      reviewScope: "full-pr",
      pageWindowHandoff: {
        page_window_checkpoint_handoff: false,
        head_ref_oid: head,
        window_index: 2,
      },
    });
    assert.equal(fake.round_count, 2);
    assert.equal(fake.dispatch_lineage.at(-1).kind, "initial");
  });
});

test("R3: proven page-window-continue still evaluates at round_count cap", () => {
  withStateDir(() => {
    const prNumber = "2804";
    const head = "d".repeat(40);
    assertReviewRoundBudget({
      prNumber,
      attempt: "initial",
      repositorySlug: "devpro/example",
      dispatchId: "dispatch-cap-base",
      headRefOid: head,
      reviewScope: "full-pr",
      pageWindowHandoff: {
        page_window_checkpoint_handoff: true,
        head_ref_oid: head,
        window_index: 1,
      },
    });
    assertReviewRoundBudget({
      prNumber,
      attempt: "focused-sticky-refresh",
      repositorySlug: "devpro/example",
      dispatchId: "dispatch-cap-2",
      headRefOid: head,
      reviewScope: "full-pr",
    });
    assertReviewRoundBudget({
      prNumber,
      attempt: "focused-sticky-refresh",
      repositorySlug: "devpro/example",
      dispatchId: "dispatch-cap-3",
      headRefOid: head,
      reviewScope: "full-pr",
    });
    assert.equal(readReviewRoundState({ prNumber, repositorySlug: "devpro/example" }).round_count, 3);

    let countingThrown = null;
    try {
      evaluateReviewRoundBudget({
        prNumber,
        repositorySlug: "devpro/example",
        attempt: "initial",
        headRefOid: head,
      });
    } catch (error) {
      countingThrown = error;
    }
    assert.ok(countingThrown);
    assert.equal(countingThrown.classification, "review_round_budget_exhausted");

    const continueEval = evaluateReviewRoundBudget({
      prNumber,
      repositorySlug: "devpro/example",
      attempt: "initial",
      headRefOid: head,
      pageWindowHandoff: {
        page_window_checkpoint_handoff: true,
        head_ref_oid: head,
        window_index: 2,
      },
    });
    assert.equal(continueEval.resolved_attempt.kind, "page-window-continue");
    assert.equal(continueEval.resolved_attempt.counting, false);

    const recorded = assertReviewRoundBudget({
      prNumber,
      attempt: "initial",
      repositorySlug: "devpro/example",
      dispatchId: "dispatch-cap-continue",
      headRefOid: head,
      reviewScope: "full-pr",
      pageWindowHandoff: {
        page_window_checkpoint_handoff: true,
        head_ref_oid: head,
        window_index: 2,
      },
    });
    assert.equal(recorded.round_count, 3, "proven continue must not increment past cap");
    assert.equal(recorded.dispatch_lineage.at(-1).kind, "page-window-continue");
  });
});

test("R3 negative: forged handoff true without prior page-window lineage still counts", () => {
  withStateDir(() => {
    const prNumber = "2805";
    const head = "e".repeat(40);
    // Prior counting entry for same head but NO page_window_index artifact.
    seedSidecar(prNumber, 1, { headRefOid: head });
    const file = reviewRoundSidecarPath({ prNumber });
    const raw = JSON.parse(readFileSync(file, "utf8"));
    raw.dispatch_lineage = [{
      round: 1,
      kind: "initial",
      attempt: "initial",
      dispatch_id: "prior-no-page-window",
      head_ref_oid: head,
      review_scope: "full-pr",
      recorded_at: new Date().toISOString(),
    }];
    writeFileSync(file, JSON.stringify(raw));

    const forged = assertReviewRoundBudget({
      prNumber,
      attempt: "initial",
      repositorySlug: "devpro/example",
      dispatchId: "dispatch-forged-handoff",
      headRefOid: head,
      reviewScope: "full-pr",
      pageWindowHandoff: {
        page_window_checkpoint_handoff: true,
        head_ref_oid: head,
        window_index: 2,
      },
    });
    assert.equal(forged.round_count, 2, "forged handoff without page-window lineage MUST still count");
    assert.equal(forged.dispatch_lineage.at(-1).kind, "initial");
    assert.notEqual(forged.dispatch_lineage.at(-1).kind, "page-window-continue");
  });
});
