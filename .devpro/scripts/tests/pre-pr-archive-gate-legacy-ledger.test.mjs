/**
 * pre-pr-archive-gate-legacy-ledger.test.mjs
 *
 * Archive gate check (c), `## Batch Approval Ledger` sub-check, for legacy
 * retired ledger items (remove-second-review-disclosure-approval design.md D3;
 * wording per remove-second-review-disclosure-framework design.md D4): an archive this PR newly adds fails closed with a
 * removal-only fix; a historical archive is neither re-validated nor rewritten.
 *
 * Fixtures are copied here instead of importing pre-pr-archive-gate.test.mjs,
 * whose tests are registered by index range and would be pulled in by an import.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp.mjs";
import { evaluateBatchApprovalLedgerShape } from "../lib/batch-approval-ledger.mjs";

const GATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../pre-pr-archive-gate.mjs");

const VALID_BRD_CONTENT =
  "# BRD — test-change\n\n" +
  "## 1. 問題陳述\n\nx\n\n" +
  "## 2. 業務目標\n\nx\n\n" +
  "## 3. 功能需求\n\nx\n\n" +
  "## 4. 非功能需求\n\nx\n\n" +
  "## 5. 範圍界定（In/Out）\n\nx\n\n" +
  "## 6. 限制與假設\n\nx\n\n" +
  "## 7. 成功標準\n\nx\n\n" +
  "## 8. 風險\n\nx\n\n" +
  "## 9. 現況分析\n\nx\n\n" +
  "## 10. 先前嘗試\n\n無\n\n" +
  "## 11. Pre-flight 驗證結果表\n\n| # | 項目 | 結果 |\n|---|---|---|\n| 1 | test | PASS |\n\n" +
  "## 12. 分支資訊\n\nx\n";

const PROPOSAL_HEADINGS_ONLY =
  "# Proposal: fixture\n\n" +
  "## Why\n\ntest fixture\n\n" +
  "## What Changes\n\ntest changes\n\n" +
  "## Requirement Ledger\n\n" +
  "| ID | Root Requirement | Parent Requirement | Current Requirement | Disposition | Owner / Next Step |\n" +
  "|---|---|---|---|---|---|\n" +
  "| R1 | fixture root | same as root | fixture current | implemented | this fixture |\n\n" +
  "## Section 3: Tasks\n\n" +
  "- [x] [Req: R1] fixture task coverage\n\n" +
  "## Issue Anchor Verification\n\n" +
  "`grep -F \"anchor\" file.md` → 1 hit @ file.md:10\n\n";

const CHANGE = "legacy-ledger-fixture";
const ARCHIVE = `2026-10-05-${CHANGE}`;
const PROPOSAL_PATH = `openspec/changes/archive/${ARCHIVE}/proposal.md`;

function ledgerSection({ covers = ["worktree", "local_commit"], excludes = ["merge", "release"], coversStyle = "block", excludesStyle = "block", namedChange = CHANGE } = {}) {
  const list = (key, items, style) => (style === "flow" ? [`${key}: [${items.join(", ")}]`] : [`${key}:`, ...items.map((item) => `  - ${item}`)]);
  return [
    "## Batch Approval Ledger",
    "",
    "kind: same-change-dp-change-batch",
    `named_change: ${namedChange}`,
    "branch: chore/fixture-branch",
    "repo_scope: same-repo",
    ...list("covers", covers, coversStyle),
    ...list("excludes", excludes, excludesStyle),
    "",
  ].join("\n");
}

function proposalWith(ledgerOptions) {
  return PROPOSAL_HEADINGS_ONLY + ledgerSection(ledgerOptions);
}

function git(repo, args) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} exited ${result.status}\n${result.stderr}`);
  return result;
}

// An archive fixture with the real git probes live. `inBaseline: false` (default): the baseline commit becomes
// origin/main and the PR commit then adds the archive, so getAddedArchives reports it as added. `inBaseline: true`:
// the archive already exists on origin/main, so this PR neither adds nor touches it.
function addedArchiveRepo(proposalContent, { inBaseline = false } = {}) {
  const dir = makeTempDir("archive-gate-legacy-ledger-");
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "fixture@example.invalid"]);
  git(dir, ["config", "user.name", "Fixture"]);
  const writeArchive = () => {
    const archiveDir = path.join(dir, "openspec/changes/archive", ARCHIVE);
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(path.join(archiveDir, "proposal.md"), proposalContent);
    writeFileSync(path.join(archiveDir, "brd.md"), VALID_BRD_CONTENT);
  };
  writeFileSync(path.join(dir, ".fixture-baseline"), "archive-gate fixture\n");
  if (inBaseline) writeArchive();
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "fixture baseline"]);
  git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  if (!inBaseline) {
    writeArchive();
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "this PR adds the archive"]);
  }
  return dir;
}

function runGate(dir) {
  return spawnSync("node", [GATE, dir], {
    encoding: "utf8",
    env: { ...process.env, DEVPRO_PR_TOUCHED_RULE_FILES: "" },
  });
}

function withAddedArchive(proposalContent, fn, options) {
  const dir = addedArchiveRepo(proposalContent, options);
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function shapeOf(content) {
  return evaluateBatchApprovalLedgerShape(content, { archiveName: ARCHIVE });
}

function assertLegacyDiagnostic(stderr, token) {
  assert.ok(stderr.includes("Pre-PR archive gate (c):"), stderr);
  assert.ok(stderr.includes(PROPOSAL_PATH), `stderr must name the archived proposal path ${PROPOSAL_PATH}: ${stderr}`);
  assert.ok(stderr.includes(token), `stderr must name ${token}: ${stderr}`);
  assert.ok(stderr.includes("delete just the `- <item>` lines"), stderr);
  assert.ok(stderr.includes("delete just those names"), stderr);
  assert.ok(stderr.includes("openspec-step-1-to-9.md"), stderr);
  assert.ok(stderr.includes("pre-merge re-archive"), stderr);
  assert.ok(stderr.includes("retired item; delete it"), stderr);
  assert.match(stderr, /retired/);
  assert.doesNotMatch(stderr, /adopt/i);
  assert.ok(!stderr.includes("consumer-adoption.md"), stderr);
}

// Apply the removal the diagnostic describes to a proposal: only the named items go.
function removeNamedItems(content, names) {
  return content.split("\n").flatMap((line) => {
    const block = /^[\t ]+-[\t ]+(\S.*?)[\t ]*$/.exec(line);
    if (block) return names.includes(block[1]) ? [] : [line];
    const flow = /^(covers|excludes):[\t ]*\[([^\]]*)\][\t ]*$/.exec(line);
    if (flow) {
      const kept = flow[2].split(",").map((entry) => entry.trim()).filter((entry) => entry && !names.includes(entry));
      return [`${flow[1]}: [${kept.join(", ")}]`];
    }
    return [line];
  }).join("\n");
}

test("Added Archive With A Retired Ledger Item Fails Check (c): a block-style covers item reviewer_sticky_write_back among other items returns legacy and the gate exits 1 with the removal-only diagnostic", () => {
  const proposal = proposalWith({ covers: ["worktree", "reviewer_sticky_write_back", "local_commit"] });
  const verdict = shapeOf(proposal);
  assert.equal(verdict?.verdict, "legacy", JSON.stringify(verdict));
  assert.deepEqual(verdict.tokens, ["reviewer_sticky_write_back"]);
  withAddedArchive(proposal, (dir) => {
    const r = runGate(dir);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}`);
    assertLegacyDiagnostic(r.stderr, "reviewer_sticky_write_back");
    // A covers-only legacy item was never refused, so no earlier-refusal notice.
    assert.doesNotMatch(r.stderr, /earlier explicit refusal/);
    assert.deepEqual(verdict.excluded_tokens, []);
    // A distinct diagnostic: neither the missing-heading nor the shape-incomplete failure.
    assert.doesNotMatch(r.stderr, /missing required heading/);
    assert.doesNotMatch(r.stderr, /present but incomplete/);
  });
});

test("Added Archive With A Retired Ledger Item Fails Check (c): a flow-style excludes external_disclosure returns legacy and the gate exits 1 with the same diagnostic", () => {
  const proposal = proposalWith({ excludes: ["merge", "release", "external_disclosure"], excludesStyle: "flow" });
  const verdict = shapeOf(proposal);
  assert.equal(verdict?.verdict, "legacy", JSON.stringify(verdict));
  assert.deepEqual(verdict.tokens, ["external_disclosure"]);
  withAddedArchive(proposal, (dir) => {
    const r = runGate(dir);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}`);
    assertLegacyDiagnostic(r.stderr, "external_disclosure");
    // The excludes item was an earlier refusal: (c) carries the same informing notice as Gate R1/SP.
    assert.deepEqual(verdict.excluded_tokens, ["external_disclosure"]);
    assert.ok(r.stderr.includes("`external_disclosure` was listed under `excludes`, an earlier explicit refusal"), r.stderr);
    assert.ok(r.stderr.includes("tell the user in the same reply"), r.stderr);
    assert.ok(r.stderr.includes("ordinary AGENTS.local.md rule"), r.stderr);
    assert.ok(r.stderr.includes("waiver path in code-review-cross-model.md §Merge Gate Enforcement"), r.stderr);
  });
});

test("Added Archive With A Retired Ledger Item Fails Check (c): Reviewer-Owned-Sticky-Write-Back matches reviewer_owned_sticky_write_back after lower-casing and replacing hyphens, and is named as written", () => {
  const proposal = proposalWith({ covers: ["worktree", "Reviewer-Owned-Sticky-Write-Back", "local_commit"] });
  const verdict = shapeOf(proposal);
  assert.equal(verdict?.verdict, "legacy", JSON.stringify(verdict));
  assert.deepEqual(verdict.tokens, ["Reviewer-Owned-Sticky-Write-Back"]);
  withAddedArchive(proposal, (dir) => {
    const r = runGate(dir);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}`);
    assertLegacyDiagnostic(r.stderr, "Reviewer-Owned-Sticky-Write-Back");
    assert.ok(!r.stderr.includes("reviewer_owned_sticky_write_back"), `normalized form must not replace the ledger's spelling: ${r.stderr}`);
  });
});

test("Added Archive With A Retired Ledger Item Fails Check (c): each of the four tokens, in covers and excludes, block and flow style, returns legacy carrying that token", () => {
  for (const token of ["same_repo_exact_pr_external_disclosure", "reviewer_sticky_write_back", "reviewer_owned_sticky_write_back", "external_disclosure"]) {
    for (const style of ["block", "flow"]) {
      const inCovers = proposalWith({ covers: ["worktree", token, "local_commit"], coversStyle: style, excludesStyle: style });
      const inExcludes = proposalWith({ excludes: ["merge", token], coversStyle: style, excludesStyle: style });
      for (const [where, proposal] of [["covers", inCovers], ["excludes", inExcludes]]) {
        const verdict = shapeOf(proposal);
        assert.equal(verdict?.verdict, "legacy", `${token} in ${style} ${where}: ${JSON.stringify(verdict)}`);
        assert.deepEqual(verdict.tokens, [token]);
      }
    }
  }
});

test("Added Archive With A Retired Ledger Item Fails Check (c): removing only the offending items as the diagnostic instructs returns ok, passes check (c), and keeps every other item", () => {
  const cases = [
    ["a block-style covers line", { covers: ["worktree", "reviewer_sticky_write_back", "local_commit"] }, ["reviewer_sticky_write_back"]],
    ["a name inside a flow-style excludes list that also holds legitimate items", { excludes: ["merge", "release", "external_disclosure"], excludesStyle: "flow" }, ["external_disclosure"]],
    ["a flow-style covers list mixing legal actions and a legacy token", { covers: ["worktree", "Reviewer-Owned-Sticky-Write-Back", "local_commit"], coversStyle: "flow" }, ["Reviewer-Owned-Sticky-Write-Back"]],
  ];
  for (const [label, options, names] of cases) {
    const proposal = proposalWith(options);
    assert.equal(shapeOf(proposal)?.verdict, "legacy", label);
    const fixed = removeNamedItems(proposal, names);
    assert.equal(shapeOf(fixed), "ok", `${label}: shape must be ok after removal`);
    for (const kept of ["worktree", "local_commit", "merge", "release"]) {
      if (kept === "local_commit" && options.covers && !options.covers.includes("local_commit")) continue;
      assert.ok(fixed.includes(kept), `${label}: ${kept} must remain`);
    }
    withAddedArchive(fixed, (dir) => {
      const r = runGate(dir);
      assert.equal(r.status, 0, `${label}: check (c) must pass after the fix, got ${r.status}: ${r.stderr}`);
    });
  }
});

test("Added Archive With A Retired Ledger Item Fails Check (c): a structurally incomplete ledger keeps its existing failure ahead of legacy", () => {
  const incomplete = PROPOSAL_HEADINGS_ONLY +
    "## Batch Approval Ledger\n\nkind: same-change-dp-change-batch\ncovers:\n  - worktree\n  - external_disclosure\n";
  assert.equal(shapeOf(incomplete), "shapeless");
  withAddedArchive(incomplete, (dir) => {
    const r = runGate(dir);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /present but incomplete/);
    assert.doesNotMatch(r.stderr, /retired ledger item/);
  });
  assert.equal(shapeOf(PROPOSAL_HEADINGS_ONLY), "absent");
});

test("Historical Archive With A Retired Ledger Item Is Not Re-Validated", () => {
  // The archive predates this PR and its ledger carries a legacy item; this PR only adds another file next to it.
  const historical = proposalWith({ covers: ["worktree", "same_repo_exact_pr_external_disclosure", "local_commit"] });
  const dir = makeTempDir("archive-gate-legacy-ledger-historical-");
  try {
    const archiveDir = path.join(dir, "openspec/changes/archive", ARCHIVE);
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(path.join(archiveDir, "proposal.md"), historical);
    writeFileSync(path.join(archiveDir, "brd.md"), VALID_BRD_CONTENT);
    git(dir, ["init", "-q", "-b", "main"]);
    git(dir, ["config", "user.email", "fixture@example.invalid"]);
    git(dir, ["config", "user.name", "Fixture"]);
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "fixture baseline (archive predates this PR)"]);
    git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

    // This PR: backfill an unrelated file next to the historical proposal without adding the proposal itself.
    writeFileSync(path.join(archiveDir, "qa-test-scope.md"), "## QA 測試範圍評估\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "backfill qa-test-scope.md into historical archive"]);

    const r = runGate(dir);
    assert.equal(r.status, 0, `check (c) must not fail on the historical archive's legacy item, got ${r.status}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /retired ledger item/);
    assert.equal(readFileSync(path.join(archiveDir, "proposal.md"), "utf8"), historical, "the archived proposal's bytes must remain unchanged");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Historical Archive With A Retired Ledger Item Is Not Re-Validated: an archive the PR only touches (env-scoped, not in the added set) is skipped and left byte-identical", () => {
  const historical = proposalWith({ excludes: ["merge", "reviewer_owned_sticky_write_back"] });
  withAddedArchive(historical, (dir) => {
    const proposalFile = path.join(dir, PROPOSAL_PATH);
    const before = readFileSync(proposalFile, "utf8");
    const r = spawnSync("node", [GATE, dir], {
      encoding: "utf8",
      env: { ...process.env, DEVPRO_PR_TOUCHED_RULE_FILES: "", DEVPRO_RELEVANT_ARCHIVES: ARCHIVE, DEVPRO_ADDED_ARCHIVES: "" },
    });
    assert.equal(r.status, 0, `touched-but-not-added archive must not be re-validated, got ${r.status}: ${r.stderr}`);
    assert.equal(readFileSync(proposalFile, "utf8"), before, "the archived proposal's bytes must remain unchanged");
  }, { inBaseline: true });
});
