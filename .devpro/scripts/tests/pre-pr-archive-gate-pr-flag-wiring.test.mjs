// strengthen-cross-review-loop-termination WARN remediation (cross-model
// finding: "the compactness advisory omits --pr, so it cannot use the
// sidecar round denominator"). pre-pr-archive-gate.mjs's own `--pr` lint
// denominator logic is already covered by lint-review-ledger-compactness.test.mjs
// (TD1-1..TD1-4) — this file proves the WIRING specifically:
//   1. pre-pr-archive-gate.mjs's own `--pr <n>` CLI flag threads through to
//      its lint-review-ledger-compactness.mjs invocation end-to-end, so the
//      printed advisory line actually uses the sidecar round_count instead
//      of always degrading to round_count_unavailable.
//   2. pre-tool-gate.mjs's Gate 3b (checkArchiveBeforePushOrPRCreate) resolves
//      a PR# and forwards it as `--pr <n>` on the spawn call when resolvable,
//      and omits it (no regression) when not.
//   3. That resolution is local-first / zero-network-cost (round-budget
//      advisor follow-up on the original WARN fix: `git push` / `gh pr
//      create` command text never carries an explicit PR#, so a naive
//      resolve would fire a live `gh pr view` lookup on every push — a real
//      network round-trip on the highest-frequency git operation, just to
//      feed a local-sidecar advisory denominator). resolveArchiveGatePrNumber
//      MUST check `listReviewRoundSidecars` first: zero sidecars skips the
//      live lookup entirely (no denominator to report either way), and only
//      >1 sidecars (ambiguous local evidence) falls through to the live
//      current-branch lookup.
//   4. Exactly one local sidecar is DELIBERATELY NOT trusted either (round 5,
//      2026-08-31, after round 2's ancestry-only check and round 3/4's
//      ancestry+head_ref_name check were each shown defeatable — round 4's
//      finding: an old PR merges, its branch is deleted, then a NEW branch
//      is created later with the SAME NAME, built on shared history that
//      still contains the old merge as an ancestor, so both factors pass).
//      No local predicate can bind to "is this actually the current PR"
//      without a live lookup, and this value is purely advisory (never
//      blocks; see pre-pr-archive-gate.mjs's printReviewLedgerCompactness-
//      Advisory) — not worth paying a live network round-trip on every push
//      to get right. A single local sidecar now resolves to no --pr,
//      identically to zero sidecars.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { recordReviewRoundDispatch } from "../hooks/lib/review-round-budget.mjs";
import { repoPath } from "./lib/repo-root.mjs";
import { makeTempDir, VALID_BRD_FIXTURE } from "./lib/tmp.mjs";

const GATE = repoPath(".devpro/scripts/pre-pr-archive-gate.mjs");
const HOOK = repoPath(".devpro/scripts/hooks/pre-tool-gate.mjs");
const tmpRoot = makeTempDir("archive-gate-pr-flag-wiring-");
let counter = 0;

after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

function git(repo, ...args) {
  const result = spawnSync(
    "git",
    ["-C", repo, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args],
    { encoding: "utf8" }
  );
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

const ARCHIVE_NAME = "2026-08-31-pr-flag-wiring";

// Same canonical proposal shape used by pre-pr-archive-gate-archived-path-smoke.test.mjs
// so this fixture reaches the compactness advisory pass-path (all lettered
// checks satisfied) instead of failing on an unrelated gate.
const VALID_PROPOSAL_CONTENT =
  "# Proposal: pr-flag wiring fixture\n\n" +
  "## Why\n\ntest fixture\n\n" +
  "## What Changes\n\ntest changes\n\n" +
  "## Requirement Ledger\n\n" +
  "| ID | Root Requirement | Parent Requirement | Current Requirement | Disposition | Owner / Next Step |\n" +
  "|---|---|---|---|---|---|\n" +
  "| R1 | fixture root | same as root | fixture current | implemented | this fixture |\n\n" +
  "## Section 3: Tasks\n\n" +
  "Full task ledger: tasks.md. Scope trace: [Req: R1].\n\n" +
  "## Issue Anchor Verification\n\n" +
  '`grep -F "anchor" file.md` → 1 hit @ file.md:10\n\n' +
  "## Batch Approval Ledger\n\nN/A: no batch approval selected\n";

function makeFixtureRepo() {
  const repo = path.join(tmpRoot, `repo-${counter++}`);
  const archiveDir = path.join(repo, "openspec/changes/archive", ARCHIVE_NAME);
  mkdirSync(archiveDir, { recursive: true });
  const init = spawnSync("git", ["init", "-q", repo], { encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  // Parentless root commit reads as indeterminate to loadArchiveIntroduction —
  // land an init commit first so the archive's introduction commit has a
  // unique parent (mirrors archived-path-smoke fixture).
  writeFileSync(path.join(repo, "README.md"), "pr-flag wiring fixture\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  writeFileSync(path.join(archiveDir, "proposal.md"), VALID_PROPOSAL_CONTENT);
  writeFileSync(path.join(archiveDir, "brd.md"), VALID_BRD_FIXTURE);
  writeFileSync(
    path.join(archiveDir, "tasks.md"),
    "# Tasks\n\n## Tasks\n\n- [x] T1 fixture task [Req: R1]\n  - 驗收: fixture assertion only\n"
  );
  writeFileSync(path.join(archiveDir, "decisions.md"), "# Decisions\n\n- D-1 fixture decision\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "archive fixture");
  git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
  // Post-archive growth well over the 30-lines/round threshold even at 5
  // rounds (200/5 = 40/round), so the advisory fires either way — only the
  // round_count denominator and round_count_unavailable flag differ.
  for (let i = 0; i < 200; i += 1) {
    appendFileSync(path.join(archiveDir, "decisions.md"), `- post-archive ledger line ${i}\n`);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "post-archive growth");
  return { repo, archiveDir };
}

function seedSidecarRoundCount({ repo, stateDir, prNumber, rounds, headRefOid = "c".repeat(40) }) {
  const prev = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = stateDir;
  try {
    for (let round = 0; round < rounds; round += 1) {
      recordReviewRoundDispatch({
        cwd: repo,
        prNumber,
        attempt: "initial",
        dispatchId: `dispatch-${round}`,
        headRefOid,
        reviewScope: "commit-range",
      });
    }
  } finally {
    if (prev === undefined) delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
    else process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = prev;
  }
}

function runGate(repo, extraArgs, extraEnv = {}) {
  return spawnSync(process.execPath, [GATE, repo, ...extraArgs], {
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
}

test("pre-pr-archive-gate --pr wiring: no --pr degrades to round_count_unavailable (no regression)", () => {
  const { repo } = makeFixtureRepo();
  const result = runGate(repo, []);
  assert.equal(result.status, 0, `gate must pass; stderr: ${result.stderr}`);
  assert.match(
    result.stdout,
    /Review ledger compactness advisory: 200 lines over 1 round\(s\) = 200\/round \(threshold 30\) round_count_unavailable/
  );
});

test("pre-pr-archive-gate --pr wiring: --pr <n> with a seeded sidecar uses round_count as the denominator", () => {
  const { repo } = makeFixtureRepo();
  const stateDir = path.join(tmpRoot, `state-${counter++}`);
  // 3 rounds = the pr-sticky lane's un-overridden budget cap (review-round-budget.mjs).
  // 200/3 = 67/round (Math.round), still over the 30/round threshold, and
  // distinct from the no-`--pr` baseline's "200 lines over 1 round(s)".
  seedSidecarRoundCount({ repo, stateDir, prNumber: "77", rounds: 3 });
  const result = runGate(repo, ["--pr", "77"], {
    DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir,
  });
  assert.equal(result.status, 0, `gate must pass; stderr: ${result.stderr}`);
  assert.match(
    result.stdout,
    /Review ledger compactness advisory: 200 lines over 3 round\(s\) = 67\/round \(threshold 30\)\n/,
    `expected sidecar round_count=3 denominator, not round_count_unavailable; got: ${result.stdout}`
  );
  assert.doesNotMatch(result.stdout, /round_count_unavailable/);
});

// --- Gate 3b wiring: pre-tool-gate.mjs resolves a PR# and forwards it -------

const STUB_GATE_CONTENT =
  "#!/usr/bin/env node\n" +
  "import { appendFileSync } from 'node:fs';\n" +
  "const traceFile = process.env.DEVPRO_TEST_ARCHIVE_GATE_TRACE_FILE;\n" +
  "if (traceFile) appendFileSync(traceFile, JSON.stringify(process.argv.slice(2)) + '\\n');\n" +
  "process.exit(0);\n";

function setupHookFixture() {
  const dir = path.join(tmpRoot, `hook-fixture-${counter++}`);
  mkdirSync(path.join(dir, ".devpro/scripts"), { recursive: true });
  writeFileSync(path.join(dir, ".devpro/scripts/pre-pr-archive-gate.mjs"), STUB_GATE_CONTENT);
  git(dir, "init", "-q", "-b", "chore/pr-flag-wiring");
  git(dir, "config", "user.email", "t@t.com");
  git(dir, "config", "user.name", "t");
  writeFileSync(path.join(dir, "README.md"), "hook fixture\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  return dir;
}

function runHook(command, fixtureDir, envOverrides = {}) {
  const payload = { tool_name: "Bash", tool_input: { command } };
  const traceFile = path.join(tmpRoot, `trace-${counter++}.jsonl`);
  const r = spawnSync(process.execPath, [HOOK], {
    cwd: fixtureDir,
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_SENTINEL_STATE_DIR: makeTempDir("archive-pr-flag-sentinel-"),
      DEVPRO_RELEVANT_ARCHIVES: "",
      PWD: fixtureDir,
      DEVPRO_TEST_ARCHIVE_GATE_TRACE_FILE: traceFile,
      ...envOverrides,
    },
  });
  let trace = [];
  try {
    trace = readFileSync(traceFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    // stub never ran / no trace written — leave trace empty, caller asserts.
  }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, trace };
}

test("Gate 3b: zero local sidecars → no --pr forwarded, live lookup never consulted", () => {
  const dir = setupHookFixture();
  const r = runHook("git push origin chore/pr-flag-wiring", dir, {
    // A live-lookup mock is set on purpose: zero sidecars must short-circuit
    // before resolveArchiveGatePrNumber ever reaches _extractPrNumber, so
    // this value must NOT appear in the forwarded argv.
    CROSS_MODEL_MERGE_GATE_MOCK_CURRENT_PR_NUMBER: "4242",
  });
  assert.equal(r.code, 0, `expected pass; stderr: ${r.stderr}`);
  assert.equal(r.trace.length, 1, `expected exactly one archive gate invocation; stderr: ${r.stderr}`);
  assert.deepEqual(
    r.trace[0].slice(1),
    [],
    `expected no --pr forwarded with zero sidecars (live lookup must not fire); got argv: ${JSON.stringify(r.trace[0])}`
  );
});

test("Gate 3b: exactly one local sidecar still resolves to no --pr (round 5: sole-sidecar trust removed entirely)", () => {
  const dir = setupHookFixture();
  const stateDir = path.join(tmpRoot, `state-${counter++}`);
  // The most favorable local evidence possible — a real ancestor SHA on
  // THIS branch, recorded while this exact branch was checked out — is what
  // every earlier trust predicate (round 2's ancestry-only, round 3/4's
  // ancestry+branch-name) would have accepted. It still resolves to no --pr
  // now: no live PR-identity lookup ran (no
  // CROSS_MODEL_MERGE_GATE_MOCK_CURRENT_PR_NUMBER set), proving this is a
  // deliberate "local state alone is never enough" policy, not a live
  // lookup that happened to come back empty.
  const headSha = git(dir, "rev-parse", "HEAD");
  seedSidecarRoundCount({ repo: dir, stateDir, prNumber: "9001", rounds: 1, headRefOid: headSha });
  const r = runHook("git push origin chore/pr-flag-wiring", dir, {
    DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir,
  });
  assert.equal(r.code, 0, `expected pass; stderr: ${r.stderr}`);
  assert.equal(r.trace.length, 1, `expected exactly one archive gate invocation; stderr: ${r.stderr}`);
  assert.deepEqual(
    r.trace[0].slice(1),
    [],
    `expected no --pr forwarded for a sole sidecar (trust removed entirely, round 5); got argv: ${JSON.stringify(r.trace[0])}`
  );
});

test("Gate 3b: ambiguous local sidecars (>1) fall through to the live current-branch lookup", () => {
  const dir = setupHookFixture();
  const stateDir = path.join(tmpRoot, `state-${counter++}`);
  seedSidecarRoundCount({ repo: dir, stateDir, prNumber: "100", rounds: 1 });
  seedSidecarRoundCount({ repo: dir, stateDir, prNumber: "200", rounds: 1 });
  const r = runHook("git push origin chore/pr-flag-wiring", dir, {
    DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir,
    CROSS_MODEL_MERGE_GATE_MOCK_CURRENT_PR_NUMBER: "4242",
  });
  assert.equal(r.code, 0, `expected pass; stderr: ${r.stderr}`);
  assert.equal(r.trace.length, 1, `expected exactly one archive gate invocation; stderr: ${r.stderr}`);
  assert.deepEqual(
    r.trace[0].slice(1),
    ["--pr", "4242"],
    `expected the live-lookup mock value (neither ambiguous sidecar PR#) forwarded; got argv: ${JSON.stringify(r.trace[0])}`
  );
});

test("Gate 3b: ambiguous local sidecars + unresolvable live lookup → spawns exactly as before (no --pr, no regression)", () => {
  const dir = setupHookFixture();
  const stateDir = path.join(tmpRoot, `state-${counter++}`);
  seedSidecarRoundCount({ repo: dir, stateDir, prNumber: "100", rounds: 1 });
  seedSidecarRoundCount({ repo: dir, stateDir, prNumber: "200", rounds: 1 });
  const r = runHook("git push origin chore/pr-flag-wiring", dir, {
    DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir,
    // Empty string forces _getCurrentBranchPrNumber's mock fallback to null
    // without invoking the real gh CLI (per its own doc comment).
    CROSS_MODEL_MERGE_GATE_MOCK_CURRENT_PR_NUMBER: "",
  });
  assert.equal(r.code, 0, `expected pass; stderr: ${r.stderr}`);
  assert.equal(r.trace.length, 1, `expected exactly one archive gate invocation; stderr: ${r.stderr}`);
  assert.deepEqual(
    r.trace[0].slice(1),
    [],
    `expected no --pr forwarded when unresolvable; got argv: ${JSON.stringify(r.trace[0])}`
  );
});
