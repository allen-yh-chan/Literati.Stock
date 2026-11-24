// TD3 (strengthen-cross-review-loop-termination R10): post-archive review
// bookkeeping fixes edit the archived change folder IN PLACE (no re-archive)
// — so the archive gate must keep passing over an archived-path state, both
// before and after such an in-place edit, and the pass output must carry the
// R8 review-ledger compactness advisory line (TD2 wiring smoke).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { repoPath } from "./lib/repo-root.mjs";
import { makeTempDir, VALID_BRD_FIXTURE } from "./lib/tmp.mjs";

const GATE = repoPath(".devpro/scripts/pre-pr-archive-gate.mjs");
const tmpRoot = makeTempDir("archived-path-smoke-");
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

const ARCHIVE_NAME = "2026-08-30-archived-path-smoke";

// Same canonical proposal shape the main gate test uses for fixtures that are
// not themselves testing heading checks (Why/What Changes for (c), Issue
// Anchor Verification for (d), Requirement Ledger + Section 3 pointer for (m),
// Batch Approval Ledger N/A for the (c) extension).
const VALID_PROPOSAL_CONTENT =
  "# Proposal: archived-path smoke fixture\n\n" +
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
  // The archive's introduction commit must have a unique parent —
  // loadArchiveIntroduction (compactness advisory base) treats a parentless
  // root commit as indeterminate — so land an init commit first.
  writeFileSync(path.join(repo, "README.md"), "archived-path smoke fixture\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  writeFileSync(path.join(archiveDir, "proposal.md"), VALID_PROPOSAL_CONTENT);
  writeFileSync(path.join(archiveDir, "brd.md"), VALID_BRD_FIXTURE);
  writeFileSync(
    path.join(archiveDir, "tasks.md"),
    "# Tasks\n\n## Tasks\n\n- [x] T1 smoke fixture task [Req: R1]\n  - 驗收: fixture assertion only\n"
  );
  writeFileSync(path.join(archiveDir, "decisions.md"), "# Decisions\n\n- D-1 fixture decision\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "archive fixture");
  // The gate's origin/main-anchored probes (token budget gate (e) baseline,
  // relevance diffs) fail closed without a remote-tracking ref — pin
  // origin/main at the archive commit like a just-pushed base.
  git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
  return { repo, archiveDir };
}

function runGate(repo) {
  return spawnSync(process.execPath, [GATE, repo], { encoding: "utf8" });
}

test("TD3-1: gate passes over an archived-path state and prints the compactness line", () => {
  const { repo } = makeFixtureRepo();
  const result = runGate(repo);
  assert.equal(result.status, 0, `gate must pass on archived state; stderr: ${result.stderr}`);
  assert.match(result.stdout, /Pre-PR archive gate: pass/);
  assert.match(
    result.stdout,
    /Review ledger compactness/,
    "pass output must carry the R8 advisory layer line (TD2 wiring)"
  );
});

test("TD3-2: in-place post-archive bookkeeping edit keeps the gate green (no re-archive)", () => {
  const { repo, archiveDir } = makeFixtureRepo();
  appendFileSync(
    path.join(archiveDir, "decisions.md"),
    "\n## Cross-Model Round Ledger\n\n| round | dispatch | head | verdict | summary |\n|---|---|---|---|---|\n| 1 | dispatch-x | abc1234 | WARN | one-line summary |\n"
  );
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "post-archive in-place bookkeeping fix");
  const result = runGate(repo);
  assert.equal(
    result.status,
    0,
    `in-place archived edit must not break the gate; stderr: ${result.stderr}`
  );
  assert.match(result.stdout, /Pre-PR archive gate: pass/);
});
