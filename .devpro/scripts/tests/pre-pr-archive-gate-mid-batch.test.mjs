/**
 * pre-pr-archive-gate-mid-batch.test.mjs
 *
 * Executable regression for issue #2430 CRITICAL: mid-batch must skip check (a)
 * while still evaluating check (i).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir, VALID_BRD_FIXTURE } from "./lib/tmp.mjs";

const GATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../pre-pr-archive-gate.mjs");

const BATCH_APPROVAL_LEDGER_NA_SECTION =
  "## Batch Approval Ledger\n\nN/A: no batch approval selected\n";

const VALID_PROPOSAL_CONTENT =
  "# Proposal: fixture\n\n" +
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
  BATCH_APPROVAL_LEDGER_NA_SECTION;

function gitFixture(repo, args, acceptedStatuses = [0]) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  assert.ok(
    acceptedStatuses.includes(result.status),
    `git ${args.join(" ")} exited ${result.status}\n${result.stderr}`
  );
  return result;
}

function setupTwoChangeMidBatchFixture() {
  const dir = makeTempDir("archive-gate-mid-batch-");
  const changesDir = path.join(dir, "openspec/changes");
  mkdirSync(path.join(changesDir, "change-b"), { recursive: true });
  writeFileSync(path.join(changesDir, "change-b", "proposal.md"), "");
  const arch = path.join(changesDir, "archive", "2026-09-03-change-a");
  mkdirSync(arch, { recursive: true });
  writeFileSync(path.join(arch, "proposal.md"), VALID_PROPOSAL_CONTENT);
  writeFileSync(path.join(arch, "brd.md"), VALID_BRD_FIXTURE);

  gitFixture(dir, ["init", "-q", "-b", "main"]);
  gitFixture(dir, ["config", "user.email", "fixture@example.invalid"]);
  gitFixture(dir, ["config", "user.name", "Fixture"]);
  writeFileSync(path.join(dir, ".fixture-baseline"), "mid-batch fixture\n");
  gitFixture(dir, ["add", "."]);
  gitFixture(dir, ["commit", "-q", "-m", "fixture baseline"]);
  gitFixture(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  return dir;
}

function runGate(fixtureDir, extraArgs = [], env = {}) {
  if (!existsSync(path.join(fixtureDir, ".git"))) {
    throw new Error("fixture missing .git");
  }
  return spawnSync("node", [GATE, fixtureDir, ...extraArgs], {
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_PR_TOUCHED_RULE_FILES: "",
      DEVPRO_DIFF_ACTIVE_CHANGES: "change-b",
      DEVPRO_RELEVANT_ARCHIVES: "2026-09-03-change-a",
      ...env,
    },
  });
}

test("unflagged gate blocks remaining sibling active (check a)", () => {
  const dir = setupTwoChangeMidBatchFixture();
  try {
    const r = runGate(dir);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /Active change folder still exists/);
    assert.match(r.stderr, /change-b/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--mid-batch skips check (a) while remaining sibling active", () => {
  const dir = setupTwoChangeMidBatchFixture();
  try {
    const r = runGate(dir, ["--mid-batch"]);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}\n${r.stdout}`);
    assert.match(r.stdout, /--mid-batch skipped check \(a\)/);
    assert.match(r.stdout, /remaining active: change-b/);
    assert.doesNotMatch(r.stderr, /Active change folder still exists/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--mid-batch still evaluates check (i)", () => {
  const dir = setupTwoChangeMidBatchFixture();
  mkdirSync(path.join(dir, "openspec/specs/archive-tooling"), { recursive: true });
  writeFileSync(
    path.join(dir, "openspec/specs/archive-tooling/spec.md"),
    "# archive-tooling\n## Purpose\nx\n## Requirements\n"
  );
  try {
    const r = runGate(dir, ["--mid-batch"], {
      DEVPRO_CHANGED_CAPABILITY_SPECS: "openspec/specs/archive-tooling/spec.md",
      DEVPRO_SCENARIO_DIFF_BASELINE_REF: "HEAD",
    });
    assert.equal(r.status, 1, `expected exit 1 from (i), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /Pre-PR archive gate \(i\)/);
    assert.match(r.stderr, /baseline ref .* resolves to the current HEAD commit/);
    assert.match(r.stdout, /--mid-batch skipped check \(a\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
