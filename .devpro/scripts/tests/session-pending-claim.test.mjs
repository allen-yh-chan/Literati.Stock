import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";
import { makeTempDir } from "./lib/tmp.mjs";

const CLAIM = repoPath(".devpro/scripts/session-pending-claim.mjs");
const claimEnv = {
  ...process.env,
  DEVPRO_SESSION_PENDING_CLAIM_LOCK_RETRY_COUNT: "20",
  DEVPRO_SESSION_PENDING_CLAIM_LOCK_RETRY_MS: "1",
};

function runClaim(cwd, args) {
  return spawnSync(process.execPath, [CLAIM, ...args], {
    cwd,
    encoding: "utf8",
    env: claimEnv,
  });
}

function runClaimAsync(cwd, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLAIM, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: claimEnv,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function deadPid() {
  const result = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(Number.isInteger(result.pid), "spawnSync should expose child pid");
  return result.pid;
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed\nstdout=${result.stdout}\nstderr=${result.stderr}`,
  );
  return result.stdout.trim();
}

function makeRepo() {
  const root = makeTempDir("devpro-spclaim-");
  const main = path.join(root, "repo");
  const wt = path.join(root, "worktree");
  mkdirSync(main, { recursive: true });
  git(main, ["init", "-q"]);
  git(main, ["config", "user.email", "devpro@example.invalid"]);
  git(main, ["config", "user.name", "Devpro Test"]);
  writeFileSync(path.join(main, "README.md"), "fixture\n");
  git(main, ["add", "README.md"]);
  git(main, ["commit", "-m", "init", "-q"]);
  git(main, ["worktree", "add", "-q", "-b", "claim-worktree", wt]);

  const notes = path.join(main, "notes");
  mkdirSync(notes, { recursive: true });
  writeFileSync(
    path.join(notes, "session-pending.md"),
    [
      "# Session Pending",
      "",
      "- **【First item】**",
      "  - observed gap: one",
      "  - 缺輸入: 無。",
      "  - trigger: tests",
      "  - carrier: new change",
      "",
      "* **【Second item】**",
      "  - observed gap: two",
      "  - 缺輸入: 無。",
      "  - trigger: tests",
      "  - carrier: new change",
      "",
    ].join("\n"),
  );

  return { root, main, wt, pending: path.join(notes, "session-pending.md") };
}

function lockPathFor(fixture) {
  return path.join(
    path.dirname(fixture.pending),
    "tmp",
    "state",
    "session-pending-claim.lock",
  );
}

function writeLock(fixture, { pid, timestamp = new Date().toISOString() }) {
  const lockPath = lockPathFor(fixture);
  mkdirSync(path.dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, `${pid}\n${timestamp}\n`);
  return lockPath;
}

test("claim from linked worktree updates main-checkout session-pending.md", () => {
  const fixture = makeRepo();
  try {
    const result = runClaim(fixture.wt, [
      "claim",
      "--item",
      "1",
      "--change",
      "enforce-session-pending-claim",
    ]);

    assert.equal(result.status, 0, result.stderr);
    const content = readFileSync(fixture.pending, "utf8");
    assert.match(content, /claimed: enforce-session-pending-claim/);
    assert.equal(
      existsSync(path.join(fixture.wt, "notes", "session-pending.md")),
      false,
      "linked worktree must not receive a ghost notes/session-pending.md",
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("claim takes over a stale lock when recorded pid is no longer live and age threshold is met", () => {
  const fixture = makeRepo();
  try {
    const lockPath = writeLock(fixture, {
      pid: deadPid(),
      timestamp: new Date(Date.now() - 11 * 60_000).toISOString(),
    });

    const result = runClaim(fixture.main, [
      "claim",
      "--item",
      "1",
      "--change",
      "stale-lock-takeover",
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(fixture.pending, "utf8"), /claimed: stale-lock-takeover/);
    assert.equal(existsSync(lockPath), false, "stale lock should be removed after claim");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("claim preserves a dead-pid lock before age threshold is met", () => {
  const fixture = makeRepo();
  try {
    const lockPath = writeLock(fixture, {
      pid: deadPid(),
      timestamp: new Date(Date.now() - 60_000).toISOString(),
    });

    const result = runClaim(fixture.main, [
      "claim",
      "--item",
      "1",
      "--change",
      "young-dead-lock-blocked",
    ]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /could not acquire lock/);
    assert.equal(existsSync(lockPath), true, "young dead-pid lock should remain unproven");
    assert.doesNotMatch(
      readFileSync(fixture.pending, "utf8"),
      /claimed: young-dead-lock-blocked/,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("claim preserves an old malformed lock as unproven", () => {
  const fixture = makeRepo();
  try {
    const lockPath = writeLock(fixture, {
      pid: "not-a-pid",
      timestamp: new Date(Date.now() - 11 * 60_000).toISOString(),
    });

    const result = runClaim(fixture.main, [
      "claim",
      "--item",
      "1",
      "--change",
      "old-malformed-lock-blocked",
    ]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /could not acquire lock/);
    assert.equal(existsSync(lockPath), true, "malformed lock should remain unproven");
    assert.doesNotMatch(
      readFileSync(fixture.pending, "utf8"),
      /claimed: old-malformed-lock-blocked/,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("claim preserves a live lock", () => {
  const fixture = makeRepo();
  try {
    const lockPath = writeLock(fixture, { pid: process.pid });

    const result = runClaim(fixture.main, [
      "claim",
      "--item",
      "1",
      "--change",
      "live-lock-blocked",
    ]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /could not acquire lock/);
    assert.equal(existsSync(lockPath), true, "live lock should remain for owner cleanup");
    assert.doesNotMatch(readFileSync(fixture.pending, "utf8"), /claimed: live-lock-blocked/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("concurrent stale-lock takeover still produces one winner", async () => {
  const fixture = makeRepo();
  try {
    const lockPath = writeLock(fixture, {
      pid: deadPid(),
      timestamp: new Date(Date.now() - 11 * 60_000).toISOString(),
    });

    const [a, b] = await Promise.all([
      runClaimAsync(fixture.main, [
        "claim",
        "--item",
        "1",
        "--change",
        "takeover-a",
      ]),
      runClaimAsync(fixture.main, [
        "claim",
        "--item",
        "1",
        "--change",
        "takeover-b",
      ]),
    ]);

    const results = [a, b].sort((left, right) => left.status - right.status);
    assert.equal(results[0].status, 0, `one takeover should win: ${JSON.stringify(results)}`);
    assert.equal(results[1].status, 1, `one takeover should lose: ${JSON.stringify(results)}`);
    assert.match(results[1].stderr, /already claimed: takeover-[ab]/);

    const content = readFileSync(fixture.pending, "utf8");
    const claims = [...content.matchAll(/claimed: (takeover-[ab])/g)].map(
      (match) => match[1],
    );
    assert.equal(claims.length, 1);
    assert.equal(existsSync(lockPath), false, "lock should be cleaned after takeover race");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("second claim for a different change fails after item is claimed", () => {
  const fixture = makeRepo();
  try {
    const first = runClaim(fixture.main, [
      "claim",
      "--item",
      "2",
      "--change",
      "first-change",
    ]);
    assert.equal(first.status, 0, first.stderr);

    const second = runClaim(fixture.main, [
      "claim",
      "--item",
      "2",
      "--change",
      "second-change",
    ]);

    assert.equal(second.status, 1);
    assert.match(second.stderr, /already claimed: first-change/);
    const content = readFileSync(fixture.pending, "utf8");
    assert.match(content, /claimed: first-change/);
    assert.doesNotMatch(content, /claimed: second-change/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("list --json exposes item indexes and claim state", () => {
  const fixture = makeRepo();
  try {
    const claim = runClaim(fixture.main, [
      "claim",
      "--item",
      "1",
      "--change",
      "listed-change",
    ]);
    assert.equal(claim.status, 0, claim.stderr);

    const listed = runClaim(fixture.main, ["list", "--json"]);
    assert.equal(listed.status, 0, listed.stderr);
    const items = JSON.parse(listed.stdout);
    assert.equal(items.length, 2);
    assert.deepEqual(items[0], {
      item: 1,
      title: "- **【First item】**",
      claimed: "listed-change",
    });
    assert.equal(items[1].item, 2);
    assert.equal(items[1].title, "* **【Second item】**");
    assert.equal(items[1].claimed, null);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("concurrent claims for one item produce one winner", async () => {
  const fixture = makeRepo();
  try {
    const [a, b] = await Promise.all([
      runClaimAsync(fixture.main, [
        "claim",
        "--item",
        "1",
        "--change",
        "race-a",
      ]),
      runClaimAsync(fixture.main, [
        "claim",
        "--item",
        "1",
        "--change",
        "race-b",
      ]),
    ]);

    const results = [a, b].sort((left, right) => left.status - right.status);
    assert.equal(results[0].status, 0, `one claim should win: ${JSON.stringify(results)}`);
    assert.equal(results[1].status, 1, `one claim should lose: ${JSON.stringify(results)}`);
    assert.match(results[1].stderr, /already claimed: race-[ab]/);

    const content = readFileSync(fixture.pending, "utf8");
    const claims = [...content.matchAll(/claimed: (race-[ab])/g)].map((match) => match[1]);
    assert.equal(claims.length, 1);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function makeH2Repo() {
  const fixture = makeRepo();
  writeFileSync(
    fixture.pending,
    [
      "# Session Pending",
      "",
      "## First H2 pending",
      "",
      "Body prose describing the gap.",
      "缺輸入: 無。",
      "trigger: tests",
      "carrier: new change",
      "",
      "## Second H2 pending",
      "",
      "Another pending with fields.",
      "缺輸入: need decision",
      "trigger: follow-up",
      "carrier: new change",
      "",
    ].join("\n"),
  );
  return fixture;
}

test("H2-only session-pending lists N sections and claim inserts under chosen section", () => {
  const fixture = makeH2Repo();
  try {
    const listed = runClaim(fixture.main, ["list", "--json"]);
    assert.equal(listed.status, 0, listed.stderr);
    const items = JSON.parse(listed.stdout);
    assert.equal(items.length, 2);
    assert.equal(items[0].title, "## First H2 pending");
    assert.equal(items[0].claimed, null);
    assert.equal(items[1].title, "## Second H2 pending");
    assert.equal(items[1].claimed, null);

    const claim = runClaim(fixture.main, [
      "claim",
      "--item",
      "1",
      "--change",
      "h2-section-claim",
    ]);
    assert.equal(claim.status, 0, claim.stderr);

    const content = readFileSync(fixture.pending, "utf8");
    const firstSection = content.slice(
      content.indexOf("## First H2 pending"),
      content.indexOf("## Second H2 pending"),
    );
    assert.match(firstSection, /  - claimed: h2-section-claim/);
    assert.doesNotMatch(
      content.slice(content.indexOf("## Second H2 pending")),
      /claimed: h2-section-claim/,
    );

    const listedAfter = runClaim(fixture.main, ["list", "--json"]);
    assert.equal(listedAfter.status, 0, listedAfter.stderr);
    const afterItems = JSON.parse(listedAfter.stdout);
    assert.equal(afterItems.length, 2);
    assert.equal(afterItems[0].claimed, "h2-section-claim");
    assert.equal(afterItems[1].claimed, null);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

// ── release / unclaim ──────────────────────────────────────────────────────
// Contract: `openspec/changes/fix-session-pending-item-parse/specs/
// pre-tool-mechanical-gates/spec.md` -> "Session-Pending Claim Release Verb".

function itemsOf(fixture) {
  const listed = runClaim(fixture.main, ["list", "--json"]);
  assert.equal(listed.status, 0, listed.stderr);
  return JSON.parse(listed.stdout);
}

// r1 finding F-SPI-03: the production file is 100% `## ` H2, but this round
// trip only exercised the legacy fixture. H2 and legacy items take different
// `end` branches inside parseBlocks — the heading branch closes on the next
// heading and folds trailing blank lines into `end`, the prose branch closes on
// the first blank run — so legacy-only coverage leaves the shape the file
// actually has unlocked. Run the same contract over both shapes, and over both
// the first and the last block: the last block is the one whose `end` is EOF
// rather than the next opener.
for (const [shape, makeFixture] of [
  ["legacy", makeRepo],
  ["H2", makeH2Repo],
]) {
  test(`release removes its own claim and restores the file byte-for-byte (${shape})`, () => {
    const fixture = makeFixture();
    try {
      const before = readFileSync(fixture.pending, "utf8");
      const beforeItems = itemsOf(fixture);
      assert.ok(
        beforeItems.length >= 2,
        `${shape} fixture needs at least 2 items to cover both the first and the last block`,
      );

      for (const index of [1, beforeItems.length]) {
        const change = `release-round-trip-${index}`;
        const claimed = runClaim(fixture.main, [
          "claim",
          "--item",
          String(index),
          "--change",
          change,
        ]);
        assert.equal(claimed.status, 0, claimed.stderr);
        assert.notEqual(
          readFileSync(fixture.pending, "utf8"),
          before,
          `claim on item ${index} must actually change the file, or the round trip proves nothing`,
        );

        const released = runClaim(fixture.main, [
          "release",
          "--item",
          String(index),
          "--change",
          change,
        ]);
        assert.equal(released.status, 0, released.stderr);

        assert.equal(
          readFileSync(fixture.pending, "utf8"),
          before,
          `claim then release on item ${index} must restore the file byte-for-byte`,
        );
        const afterItems = itemsOf(fixture);
        assert.equal(afterItems.length, beforeItems.length, "block count must be unchanged");
        assert.deepEqual(
          afterItems.map((entry) => entry.title),
          beforeItems.map((entry) => entry.title),
          "every item index must still address the same block",
        );
        assert.equal(afterItems[index - 1].claimed, null);
      }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

test("releasing an unclaimed item is a no-op that does not write", () => {
  const fixture = makeRepo();
  try {
    const before = readFileSync(fixture.pending, "utf8");
    const result = runClaim(fixture.main, [
      "release",
      "--item",
      "2",
      "--change",
      "never-claimed",
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /not claimed|no-op|already released/i);
    assert.equal(readFileSync(fixture.pending, "utf8"), before);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("releasing another change's claim fails visibly and does not write", () => {
  const fixture = makeRepo();
  try {
    const claimed = runClaim(fixture.main, [
      "claim",
      "--item",
      "1",
      "--change",
      "owner-change",
    ]);
    assert.equal(claimed.status, 0, claimed.stderr);
    const afterClaim = readFileSync(fixture.pending, "utf8");

    const result = runClaim(fixture.main, [
      "release",
      "--item",
      "1",
      "--change",
      "intruder-change",
    ]);
    assert.equal(result.status, 1, `expected exit 1, got ${result.status}`);
    assert.match(result.stderr, /owner-change/, "message must name the current owner");
    assert.equal(
      readFileSync(fixture.pending, "utf8"),
      afterClaim,
      "a refused release must not touch the file",
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("the unclaim alias behaves identically to release", () => {
  const viaRelease = makeRepo();
  const viaUnclaim = makeRepo();
  try {
    for (const [fixture, verb] of [
      [viaRelease, "release"],
      [viaUnclaim, "unclaim"],
    ]) {
      const claimed = runClaim(fixture.main, [
        "claim",
        "--item",
        "1",
        "--change",
        "alias-parity",
      ]);
      assert.equal(claimed.status, 0, claimed.stderr);
      fixture.result = runClaim(fixture.main, [
        verb,
        "--item",
        "1",
        "--change",
        "alias-parity",
      ]);
    }

    // Both halves must SUCCEED, not merely fail the same way — otherwise this
    // passes vacuously while neither verb exists.
    assert.equal(viaRelease.result.status, 0, viaRelease.result.stderr);
    assert.equal(viaUnclaim.result.status, 0, viaUnclaim.result.stderr);
    assert.equal(itemsOf(viaRelease)[0].claimed, null);
    assert.equal(itemsOf(viaUnclaim)[0].claimed, null);

    assert.equal(viaUnclaim.result.status, viaRelease.result.status);
    assert.equal(viaUnclaim.result.stdout, viaRelease.result.stdout);
    assert.equal(
      readFileSync(viaUnclaim.pending, "utf8"),
      readFileSync(viaRelease.pending, "utf8"),
    );
  } finally {
    rmSync(viaRelease.root, { recursive: true, force: true });
    rmSync(viaUnclaim.root, { recursive: true, force: true });
  }
});

test("release validates --item and --change exactly as claim does", () => {
  const fixture = makeRepo();
  try {
    for (const args of [
      ["release", "--item", "0", "--change", "some-change"],
      ["release", "--item", "1", "--change", "Not-Kebab"],
      ["release", "--item", "99", "--change", "some-change"],
    ]) {
      const result = runClaim(fixture.main, args);
      assert.notEqual(result.status, 0, `expected failure for: ${args.join(" ")}`);
      // The rejection must come from release's own validation, not from the
      // verb being unknown — otherwise this passes vacuously before the verb
      // exists.
      assert.doesNotMatch(
        result.stderr,
        /unknown command/,
        `release must exist and reject on its own terms: ${args.join(" ")}`,
      );
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

/*
 * check-shape verb. r3 finding F-SPI-18: the verb shipped with zero behavioural
 * coverage — the only repo-wide hit for its name was a documentation anchor
 * asserting the string appears in a rule leaf. These three lock the exit-code
 * contract across the verb's whole scope partition, and every case also asserts
 * the two read-only MUSTs (no lock taken, file bytes untouched) so the verb
 * cannot quietly acquire a side effect.
 */

/** Replace the fixture's pending file, returning its exact bytes. */
function writePending(fixture, lines) {
  const content = lines.join("\n");
  writeFileSync(fixture.pending, content);
  return content;
}

/** Every check-shape run is read-only: no lock left behind, bytes unchanged. */
function assertReadOnly(fixture, before) {
  assert.equal(
    existsSync(lockPathFor(fixture)),
    false,
    "check-shape must not take the claim lock",
  );
  assert.equal(
    readFileSync(fixture.pending, "utf8"),
    before,
    "check-shape must not write to the pending file",
  );
}

test("check-shape exits 0 and reports out-of-scope for a legacy-only file", () => {
  const fixture = makeRepo();
  try {
    // makeRepo's fixture is the legacy shape: two column-0 bullets, zero `## `.
    const before = readFileSync(fixture.pending, "utf8");
    const result = runClaim(fixture.wt, ["check-shape"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /legacy-only file/);
    assertReadOnly(fixture, before);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("check-shape exits 0 for an H2-adopted file with no column-0 bullets", () => {
  const fixture = makeRepo();
  try {
    const before = writePending(fixture, [
      "# Session Pending",
      "",
      "## 1. First item",
      "",
      "  - 缺輸入: 無。",
      "  - trigger: tests",
      "  - carrier: new change",
      "",
    ]);
    const result = runClaim(fixture.wt, ["check-shape"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /no column-0/);
    assertReadOnly(fixture, before);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("check-shape exits non-zero and names the line for an in-scope violation", () => {
  const fixture = makeRepo();
  try {
    const before = writePending(fixture, [
      "# Session Pending", // 1
      "", // 2
      "## 1. First item", // 3
      "", // 4
      "  - 缺輸入: 無。", // 5
      "  - trigger: tests", // 6
      "  - carrier: new change", // 7
      "", // 8
      "- stray column-0 bullet", // 9
      "", // 10
    ]);
    const result = runClaim(fixture.wt, ["check-shape"]);
    assert.notEqual(result.status, 0, "an in-scope violation must exit non-zero");
    assert.match(result.stdout, /1 column-0 bullet\(s\)/);
    // Bind the reported number to the line the bullet is actually on, not to
    // any digit — the same discipline r1 finding F-SPI-05 was raised for.
    assert.match(result.stdout, /^ {2}9: - stray column-0 bullet$/m);
    assertReadOnly(fixture, before);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("fix-silent-gate-skip R2: lock failure names openspec/changes/ next step", () => {
  const fixture = makeRepo();
  try {
    writeLock(fixture, {
      pid: process.pid,
      timestamp: new Date().toISOString(),
    });
    const result = runClaim(fixture.main, [
      "claim",
      "--item",
      "1",
      "--change",
      "lock-next-step",
    ]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /could not acquire lock/);
    assert.match(result.stderr, /openspec\/changes\//);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("missing pending file exits 2 for list and check-shape", () => {
  const fixture = makeRepo();
  try {
    rmSync(fixture.pending, { force: true });
    for (const verb of ["list", "check-shape"]) {
      const result = runClaim(fixture.main, [verb]);
      assert.equal(result.status, 2, `${verb}: ${result.stderr}`);
      assert.match(result.stderr, /session-pending\.md not found/);
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("usage documents exit code 2 fail-closed paths", () => {
  const help = runClaim(process.cwd(), []);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Exit codes:[\s\S]*\b2\b/);
  assert.match(help.stdout, /missing pending file/i);
  assert.match(help.stdout, /claimedBy/i);
  const src = readFileSync(CLAIM, "utf8");
  assert.match(src, /error\.exitCode = 2/);
  assert.match(src, /claim line for .+ not found inside the item's own line range/);
});
