/**
 * pre-pr-archive-gate-pre-review.test.mjs
 *
 * Executable regression for decisions.md D34 / R12: the reviewer dispatch must be
 * the last step before archive, so gate (e)'s archive-independent
 * source-governance topology has to be assertable BEFORE the archive exists.
 * `--pre-review` skips check (a) and reads the attestation from the ACTIVE
 * change proposal; the post-archive run keeps reading the archived proposal.
 *
 * It is also where the R6 / D16 regression-head currency assertion runs: the
 * canonical suite must have been recorded green at the CURRENT committed HEAD
 * before the six-axis reviewer is dispatched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, appendFileSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp.mjs";
import { writeRegressionHeadRecord } from "../lib/regression-head-record.mjs";
import {
  BRD_REQUIRED_HEADINGS,
  classifyExistingBrdDirectory,
  classifyOwnedChangeBrd,
  validateRequiredBrd,
} from "../lib/brd-required-headings.mjs";
import { noneEvidenceMarkdown } from "../lib/named-def-corpus-grep-evidence.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATE = path.resolve(HERE, "../pre-pr-archive-gate.mjs");
const ACTIVE = "pre-review-change";
const ARCHIVED = "2026-09-03-earlier-change";

const PROPOSAL_BASE =
  "# Proposal: fixture\n\n" +
  "## Why\n\ntest fixture\n\n" +
  "## What Changes\n\ntest changes\n\n" +
  "## Requirement Ledger\n\n" +
  "| ID | Root Requirement | Parent Requirement | Current Requirement | Disposition | Owner / Next Step |\n" +
  "|---|---|---|---|---|---|\n" +
  "| R1 | fixture root | same as root | fixture current | implemented | this fixture |\n\n" +
  "## Section 2: Touch\n\n| Path | Category | Action | Requirement |\n|---|---|---|---|\n| `.claude/agents/alpha.md` | code | edit | R1 |\n| `.claude/agents/beta.md` | code | edit | R1 |\n| `later.md` | code | edit | R1 |\n| `openspec/specs/fixture-cap/spec.md` | code | edit | R1 |\n| `.devpro/agent-rules/fixture-leaf.md` | code | edit | R1 |\n\n" +
  "## Section 3: Tasks\n\nFull task ledger: tasks.md. Scope trace: [Req: R1].\n\n" +
  "## Issue Anchor Verification\n\n" +
  '`grep -F "anchor" file.md` → 1 hit @ file.md:10\n\n' +
  "## Batch Approval Ledger\n\nN/A: no batch approval selected\n\n" +
  noneEvidenceMarkdown("fixture: no new named definitions");

const VALID_BRD = [
  "# BRD: fixture",
  "問題陳述",
  "業務目標",
  "功能需求",
  "非功能需求",
  "範圍界定",
  "限制與假設",
  "成功標準",
  "風險",
  "現況分析",
  "先前嘗試",
  "Pre-flight 驗證結果表",
  "分支資訊",
].map((heading, index) => index === 0 ? heading : `## ${heading}\n\nfixture`).join("\n\n") + "\n";

// One modification plus one addition of bounded source-governance carriers is the
// `ambiguous` topology, which is exactly the state that demands an attestation.
const ATTESTATION =
  "\n## Source Governance Attestation\n\n" +
  "Source-Governance-Action: none; carriers=.claude/agents/alpha.md,.claude/agents/beta.md; " +
  "evidence=M:.claude/agents/alpha.md,?:.claude/agents/beta.md\n";

function git(repo, args) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} exited ${result.status}\n${result.stderr}`);
  return result;
}

/**
 * `regressionHead`:
 *   "current"  — receipt written at the commit that is still HEAD (the state a
 *                TL is in right after running the suite and the recorder)
 *   "stale"    — receipt written, then another commit lands (item `## 107.`'s
 *                actual shape: suite green at HEAD1, Step 2 commits to HEAD2)
 *   "missing"  — no receipt at all
 *   "corrupt"  — a receipt that exists but cannot be trusted
 * `boundedCarriers: false` leaves the worktree clean of bounded
 * source-governance carriers, which is the `none` topology — used to reach the
 * regression-head assertion without gate (e) having an opinion.
 * `identity` selects the classifyRepoIdentity evidence the fixture carries:
 *   "source"   — devpro-agent-rules origin + maintained-corpus sentinels
 *   "consumer" — installed `.devpro-agent-rules/` tree + non-source origin
 *   "unknown"  — neither evidence set
 */
const DEFAULT_TASKS_BODY =
  "## Tasks\n\n" +
  "- [x] **T1 — Fixture task.** Cover the fixture ledger row. [Req: R1]\n" +
  "  - 驗收: fixture R1 covered\n";

function fixture({ attestationIn, regressionHead = "current", boundedCarriers = true, activeBrd = VALID_BRD, archiveBrd = VALID_BRD, identity = "source", tasksBody = DEFAULT_TASKS_BODY }) {
  const dir = makeTempDir("archive-gate-pre-review-");
  const changesDir = path.join(dir, "openspec/changes");
  mkdirSync(path.join(changesDir, ACTIVE), { recursive: true });
  mkdirSync(path.join(changesDir, "archive", ARCHIVED), { recursive: true });
  mkdirSync(path.join(dir, ".claude/agents"), { recursive: true });
  if (identity === "source") {
    // Source identity sentinels (classifyRepoIdentity).
    mkdirSync(path.join(dir, ".devpro/scripts"), { recursive: true });
    mkdirSync(path.join(dir, ".devpro/agent-rules"), { recursive: true });
    writeFileSync(path.join(dir, ".devpro/scripts/pre-pr-archive-gate.mjs"), "// sentinel\n");
    writeFileSync(path.join(dir, ".devpro/agent-rules/rule-audit-playbook.md"), "# sentinel\n");
  }
  if (identity === "consumer") {
    // Direct-adoption positive evidence (consumerRootHasPositiveEvidence): the
    // installed rules tree inside the repository, with an origin that is not
    // the source corpus.
    mkdirSync(path.join(dir, ".devpro-agent-rules/.devpro/scripts"), { recursive: true });
    writeFileSync(path.join(dir, ".devpro-agent-rules/AGENTS.md"), "# consumer fixture\n");
    writeFileSync(path.join(dir, ".devpro-agent-rules/.devpro/scripts/sync-agent-rules.mjs"), "// sentinel\n");
  }
  writeFileSync(path.join(dir, ".claude/agents/alpha.md"), "# alpha\n");

  const proposalFor = (target) => PROPOSAL_BASE + (attestationIn === target ? ATTESTATION : "");
  writeFileSync(path.join(changesDir, ACTIVE, "proposal.md"), proposalFor("active"));
  writeFileSync(path.join(changesDir, "archive", ARCHIVED, "proposal.md"), proposalFor("archive"));
  writeFileSync(path.join(changesDir, ACTIVE, "tasks.md"), tasksBody);
  writeFileSync(
    path.join(changesDir, ACTIVE, "decisions.md"),
    "## Requirement Baseline Ledger\n" +
      "| decision_id | trigger | baseline_from | baseline_to |\n" +
      "|---|---|---|---|\n" +
      "| D1 | initial | 0 | 1 |\n\n" +
      "## D1: fixture baseline\n",
  );
  if (activeBrd !== null) writeFileSync(path.join(changesDir, ACTIVE, "brd.md"), activeBrd);
  if (archiveBrd !== null) writeFileSync(path.join(changesDir, "archive", ARCHIVED, "brd.md"), archiveBrd);
  // Mirrors the real repo (.gitignore:5). The regression-head receipt lives
  // under notes/, and `ls-files --others --exclude-standard` is what gate (e)
  // reads for untracked carriers — an unignored receipt would show up as an
  // untracked file and change the topology under test.
  writeFileSync(path.join(dir, ".gitignore"), "notes/\n");

  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "fixture@example.invalid"]);
  git(dir, ["config", "user.name", "Fixture"]);
  git(dir, ["remote", "add", "origin", identity === "source"
    ? "https://example.invalid/devpro-agent-rules.git"
    : "https://example.invalid/consumer-business-repo.git"]);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "fixture baseline"]);
  git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

  // R6 / D16 receipt. `makeTempDir` gives a real `git init` repo, so
  // `defaultMainCheckoutRoot` resolves to `dir` itself — the receipt lands in
  // this fixture's own notes/, never the developer's.
  if (regressionHead !== "missing") {
    const recorded = git(dir, ["rev-parse", "HEAD"]).stdout.trim();
    const written = writeRegressionHeadRecord({ cwd: dir, change: ACTIVE, headSha: recorded, branch: "main",
      suiteEvidence: PASS_SUITE_EVIDENCE,
    });
    assert.equal(written.status, "written", `fixture receipt write failed: ${written.reason}`);
    // realpath: macOS resolves /var -> /private/var, and the receipt path comes
    // back through `repoStateIdentity`, which realpaths. Same directory.
    assert.equal(
      path.dirname(path.dirname(written.recordPath)),
      realpathSync(dir),
      "receipt must land inside the fixture, never the developer's own notes/"
    );
    if (regressionHead === "corrupt") {
      writeFileSync(written.recordPath, '{"change": "pre-review-change", "head_sha": "not-a-sha"}\n');
    }
  }
  if (regressionHead === "stale") {
    writeFileSync(path.join(dir, "later.md"), "landed after the suite was recorded green\n");
    git(dir, ["add", "later.md"]);
    git(dir, ["commit", "-q", "-m", "a commit after the suite ran"]);
  }

  if (boundedCarriers) {
    // M + untracked A on bounded carriers → ambiguous topology.
    appendFileSync(path.join(dir, ".claude/agents/alpha.md"), "modified\n");
    writeFileSync(path.join(dir, ".claude/agents/beta.md"), "# beta\n");
  }
  return dir;
}

const PASS_SUITE_EVIDENCE = { status: "pass", fail: 0, digest_sha256: "c".repeat(64) };
test("--pre-review fails when an owned full change has no brd.md", () => {
  const dir = fixture({ attestationIn: "active", activeBrd: null });
  try {
    const r = runGate(dir, ["--pre-review"]);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}\n${r.stdout}`);
    assert.match(r.stderr, /brd\.md/);
    assert.match(r.stderr, /pre-review-change/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--pre-review fails when an owned full change brd.md is missing one of the 12 headings", () => {
  const incomplete = VALID_BRD.replace("## 分支資訊\n\nfixture\n", "");
  const dir = fixture({ attestationIn: "active", activeBrd: incomplete });
  try {
    const r = runGate(dir, ["--pre-review"]);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}\n${r.stdout}`);
    assert.match(r.stderr, /分支資訊/);
    assert.match(r.stderr, /12/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BRD required headings use normalized exact titles, so every omission is detected", async (t) => {
  for (const required of BRD_REQUIRED_HEADINGS) {
    await t.test(required, () => {
      const root = makeTempDir("brd-required-heading-");
      const dir = path.join(root, "change");
      mkdirSync(dir);
      try {
        writeFileSync(path.join(dir, "proposal.md"), "# Proposal\n");
        writeFileSync(path.join(dir, "brd.md"), VALID_BRD.replace(`## ${required}\n\nfixture`, ""));
        const verdict = validateRequiredBrd(dir);
        assert.deepEqual(
          { ok: verdict.ok, code: verdict.code, missing: verdict.missing },
          { ok: false, code: "brd-headings-missing", missing: [required] },
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  await t.test("terminal parenthetical annotation remains a supported heading variant", () => {
    const root = makeTempDir("brd-required-heading-variant-");
    const dir = path.join(root, "change");
    mkdirSync(dir);
    try {
      writeFileSync(path.join(dir, "proposal.md"), "# Proposal\n");
      writeFileSync(path.join(dir, "brd.md"), VALID_BRD.replace("## 範圍界定", "## 範圍界定（In/Out）"));
      assert.equal(validateRequiredBrd(dir).ok, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("the established numeric ordinal prefix remains supported", () => {
    const root = makeTempDir("brd-required-heading-ordinal-");
    const dir = path.join(root, "change");
    mkdirSync(dir);
    try {
      writeFileSync(path.join(dir, "proposal.md"), "# Proposal\n");
      const numbered = BRD_REQUIRED_HEADINGS.reduce(
        (body, heading, index) => body.replace(`## ${heading}`, `## ${index + 1}. ${heading}`),
        VALID_BRD,
      );
      writeFileSync(path.join(dir, "brd.md"), numbered);
      assert.equal(validateRequiredBrd(dir).ok, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("--pre-review reports BRD N/A for proposal-mini-only B-mini", () => {
  const dir = fixture({ attestationIn: "active", regressionHead: "current", boundedCarriers: false, activeBrd: null });
  try {
    rmSync(path.join(dir, "openspec/changes", ACTIVE, "proposal.md"));
    writeFileSync(path.join(dir, "openspec/changes", ACTIVE, "proposal-mini.md"), PROPOSAL_BASE);
    const r = runGate(dir, ["--pre-review"]);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}\n${r.stdout}`);
    assert.match(r.stdout, /proven-b-mini; BRD is explicitly N\/A/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--pre-review fails closed when the owned proposal carrier class is unknown", () => {
  const dir = fixture({ attestationIn: "active" });
  try {
    writeFileSync(path.join(dir, "openspec/changes", ACTIVE, "proposal-mini.md"), PROPOSAL_BASE);
    const r = runGate(dir, ["--pre-review"]);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}\n${r.stdout}`);
    assert.match(r.stderr, /proposal carrier class is unknown/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BRD artifact class table is byte-exact and fails closed on unsafe or faulty carriers", async (t) => {
  const make = () => {
    const root = makeTempDir("brd-class-");
    const dir = path.join(root, "change");
    mkdirSync(dir);
    return { root, dir };
  };
  for (const [name, arrange, expected] of [
    ["proposal only required", (dir) => writeFileSync(path.join(dir, "proposal.md"), "x"), { ok: true, applicability: "required", code: null }],
    ["proposal-mini only is B-mini N/A", (dir) => writeFileSync(path.join(dir, "proposal-mini.md"), "x"), { ok: true, applicability: "not-applicable", code: null }],
    ["both exact carriers ambiguous", (dir) => { writeFileSync(path.join(dir, "proposal.md"), "x"); writeFileSync(path.join(dir, "proposal-mini.md"), "x"); }, { ok: false, applicability: "unknown", code: "proposal-carrier-ambiguous" }],
    ["neither carrier unknown", () => {}, { ok: false, applicability: "unknown", code: "artifact-class-unknown" }],
    ["case near miss rejected", (dir) => writeFileSync(path.join(dir, "Proposal.md"), "x"), { ok: false, applicability: "unknown", code: "proposal-carrier-case-mismatch" }],
    ["non-regular exact carrier rejected", (dir) => mkdirSync(path.join(dir, "proposal.md")), { ok: false, applicability: "unknown", code: "proposal-carrier-invalid" }],
    ["symlink exact carrier rejected", (dir) => { writeFileSync(path.join(dir, "target"), "x"); symlinkSync("target", path.join(dir, "proposal.md")); }, { ok: false, applicability: "unknown", code: "proposal-carrier-invalid" }],
  ]) {
    await t.test(name, () => {
      const { root, dir } = make();
      try {
        arrange(dir);
        const verdict = classifyExistingBrdDirectory(dir);
        assert.deepEqual({ ok: verdict.ok, applicability: verdict.applicability, code: verdict.code }, expected);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }
  await t.test("scan fault has exact code", () => {
    const { root, dir } = make();
    try {
      const verdict = classifyExistingBrdDirectory(dir, { readdir: () => { throw Object.assign(new Error("fault"), { code: "EIO" }); } });
      assert.equal(verdict.code, "proposal-scan-failed");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

test("true chore A requires active ENOENT and zero exact archive candidates", () => {
  const root = makeTempDir("brd-chore-a-");
  try {
    mkdirSync(path.join(root, "openspec", "changes"), { recursive: true });
    const verdict = classifyOwnedChangeBrd({ repoRoot: root, changeId: "chore-a-fixture" });
    assert.deepEqual({ ok: verdict.ok, applicability: verdict.applicability, reason: verdict.reason }, {
      ok: true, applicability: "not-applicable", reason: "proven-chore-a",
    });
    mkdirSync(path.join(root, "openspec", "changes", "archive", "2026-01-01-chore-a-fixture"), { recursive: true });
    assert.equal(classifyOwnedChangeBrd({ repoRoot: root, changeId: "chore-a-fixture" }).code, "artifact-class-unknown");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function changeBaseOf(dir) {
  return git(dir, ["rev-list", "--max-parents=0", "HEAD"]).stdout.trim().split("\n")[0];
}

function runGate(dir, extraArgs = [], extraEnv = {}) {
  const args = [...extraArgs];
  if (args.includes("--pre-review") && !args.includes("--change-base-ref") && !args.includes("--mid-batch")) {
    args.push("--change-base-ref", changeBaseOf(dir));
  }
  return spawnSync("node", [GATE, dir, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_DIFF_ACTIVE_CHANGES: ACTIVE,
      DEVPRO_RELEVANT_ARCHIVES: ARCHIVED,
      ...extraEnv,
    },
  });
}

test("--pre-review and --mid-batch are different phases and cannot be combined", () => {
  const dir = fixture({ attestationIn: "active" });
  try {
    const r = runGate(dir, ["--pre-review", "--mid-batch"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /MUST NOT be combined/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("chore A classification fails closed when the archive root is a symlink", () => {
  const root = makeTempDir("brd-chore-a-archive-root-");
  try {
    const changesRoot = path.join(root, "openspec", "changes");
    const outside = path.join(root, "outside-archive");
    mkdirSync(changesRoot, { recursive: true });
    mkdirSync(outside);
    symlinkSync(outside, path.join(changesRoot, "archive"));
    const verdict = classifyOwnedChangeBrd({ repoRoot: root, changeId: "chore-a-fixture" });
    assert.deepEqual(
      { ok: verdict.ok, applicability: verdict.applicability, code: verdict.code },
      { ok: false, applicability: "unknown", code: "archive-scan-failed" },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--pre-review resolves the attestation from the active proposal and skips check (a)", () => {
  const dir = fixture({ attestationIn: "active" });
  try {
    const r = runGate(dir, ["--pre-review"]);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}\n${r.stdout}`);
    assert.match(r.stdout, /--pre-review asserted the archive-independent source-governance topology \(e\)/);
    assert.match(r.stdout, new RegExp(`\\(${ACTIVE}\\)`));
    assert.match(r.stdout, /Archive-dependent checks/);
    assert.doesNotMatch(r.stderr, /Active change folder still exists/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--pre-review fails closed when the active proposal carries no attestation for an ambiguous topology", () => {
  const dir = fixture({ attestationIn: "archive" });
  try {
    const r = runGate(dir, ["--pre-review"]);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stdout}`);
    assert.match(r.stderr, /ambiguous source-governance topology: expected one exact attestation, found 0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the post-archive phase still reads the archived proposal, not the active one", () => {
  const active = fixture({ attestationIn: "active" });
  try {
    const r = runGate(active, ["--mid-batch"]);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stdout}`);
    assert.match(r.stderr, /expected one exact attestation, found 0/);
  } finally {
    rmSync(active, { recursive: true, force: true });
  }
  const archived = fixture({ attestationIn: "archive" });
  try {
    const r = runGate(archived, ["--mid-batch"]);
    assert.doesNotMatch(r.stderr, /ambiguous source-governance topology/);
  } finally {
    rmSync(archived, { recursive: true, force: true });
  }
});


// ── R6 / D16: the regression-head currency assertion ────────────────────────
//
// notes item `## 107.` in one sentence: mechanical checks ordered AFTER the
// six-axis review make zero-value re-review rounds the process default. The
// reviewer is the last step before archive, so this is the last place a
// machine can still answer "was the suite even run against this tree?" for
// free. Three states, per D16: match passes, mismatch names both shas, and a
// missing receipt fails closed — absence of evidence is not evidence of green.

const SHA_40 = /\b[0-9a-f]{40}\b/g;

test("--pre-review passes when the receipt names the current HEAD", () => {
  const dir = fixture({ attestationIn: "active", regressionHead: "current" });
  try {
    const r = runGate(dir, ["--pre-review"]);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}\n${r.stdout}`);
    assert.match(
      r.stdout,
      /Regression-head receipt asserted for pre-review-change: the canonical suite currency is ok at HEAD [0-9a-f]{40} \(R6; exact HEAD or bookkeeping tip-move\)/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--pre-review fails closed and names BOTH shas when HEAD moved after the suite ran", () => {
  const dir = fixture({ attestationIn: "active", regressionHead: "stale" });
  try {
    const r = runGate(dir, ["--pre-review"]);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stdout}`);
    assert.match(r.stderr, /has not been recorded green at the current HEAD/);
    assert.match(r.stderr, /HEAD moved after the suite was recorded green/);

    // The author must be able to see WHICH tree was tested and WHICH is being
    // reviewed; one sha alone leaves them to work out which half is stale.
    const shas = [...new Set(String(r.stderr).match(SHA_40) || [])];
    assert.equal(shas.length, 2, `expected two distinct 40-hex shas in stderr, got ${shas.length}:\n${r.stderr}`);
    const tested = git(dir, ["rev-parse", "HEAD~1"]).stdout.trim();
    const current = git(dir, ["rev-parse", "HEAD"]).stdout.trim();
    assert.match(r.stderr, new RegExp(`tested HEAD : ${tested}`));
    assert.match(r.stderr, new RegExp(`current HEAD: ${current}`));

    // And the remedy has to be a command, not a description of one.
    assert.match(r.stderr, /node \.devpro\/scripts\/record-regression-head\.mjs --change pre-review-change/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--pre-review fails closed when no receipt exists (missing evidence is not green)", () => {
  const dir = fixture({ attestationIn: "active", regressionHead: "missing" });
  try {
    const r = runGate(dir, ["--pre-review"]);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stdout}`);
    assert.match(r.stderr, /an unrecorded suite run is not evidence about this tree/);
    assert.match(r.stderr, /tested HEAD : \(none recorded\)/);
    assert.match(r.stderr, /qa-regression-head-pre-review-change\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--pre-review fails closed on a receipt that exists but cannot be trusted", () => {
  const dir = fixture({ attestationIn: "active", regressionHead: "corrupt" });
  try {
    const r = runGate(dir, ["--pre-review"]);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stdout}`);
    assert.match(r.stderr, /receipt cannot be trusted: head_sha is not 40-hex/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// R1 / design.md D1 of fix-consumer-pre-pr-gates — the R6 receipt is a
// source-maintainer artifact: the canonical suite emits no digest for a
// consumer context, so a consumer repository is not asked for
// notes/qa-regression-head-<change>.json. It gets a NAMED skip instead, and
// that skip must not be shaped like the source "already satisfied" line.
test("--pre-review skips the source-maintainer R6 receipt assertion in a consumer repository", () => {
  const dir = fixture({
    attestationIn: "active",
    identity: "consumer",
    regressionHead: "missing",
    boundedCarriers: false,
  });
  try {
    const r = runGate(dir, ["--pre-review"]);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}\n${r.stdout}`);
    assert.match(
      r.stdout,
      /Pre-PR archive gate: consumer repository — skipping the source-maintainer canonical-suite regression-head receipt assertion \(R6\)\./,
    );
    assert.match(r.stdout, /^ {2}identity : consumer \(direct adoption evidence\)$/m);
    assert.match(r.stdout, /^ {2}changes {2}: pre-review-change$/m);
    assert.match(
      r.stdout,
      /^ {2}reason {3}: the canonical suite and its pass\/fail=0\/digest receipt are source-maintainer-only; notes\/qa-regression-head-<change>\.json is not required in a consumer repository\.$/m,
    );
    assert.match(
      r.stdout,
      /^ {2}evidence : consumer test evidence is carried by the project-agreed test command, PR Test Evidence, consumer CI, and six-axis axis 4\.$/m,
    );
    // Not the "already satisfied" shape.
    assert.doesNotMatch(r.stdout, /currency is ok/);
    assert.doesNotMatch(r.stdout, /Regression-head receipt asserted/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--pre-review consumer skip names every owned active change", () => {
  // Two owned active changes in a consumer repository: the skip block is a
  // single named block whose `changes` line lists both (design D1 shape).
  const dir = fixture({
    attestationIn: "active",
    identity: "consumer",
    regressionHead: "missing",
    boundedCarriers: false,
  });
  try {
    const second = "pre-review-change-two";
    mkdirSync(path.join(dir, "openspec/changes", second), { recursive: true });
    writeFileSync(path.join(dir, "openspec/changes", second, "proposal.md"), PROPOSAL_BASE);
    writeFileSync(path.join(dir, "openspec/changes", second, "brd.md"), VALID_BRD);
    writeFileSync(
      path.join(dir, "openspec/changes", second, "tasks.md"),
      "## Tasks\n\n- [x] **T1 — Fixture task.** Cover the fixture ledger row. [Req: R1]\n  - 驗收: fixture R1 covered\n",
    );
    writeFileSync(
      path.join(dir, "openspec/changes", second, "decisions.md"),
      "## Requirement Baseline Ledger\n| decision_id | trigger | baseline_from | baseline_to |\n|---|---|---|---|\n| D1 | initial | 0 | 1 |\n\n## D1: fixture baseline\n",
    );
    const r = spawnSync("node", [GATE, dir, "--pre-review", "--change-base-ref", changeBaseOf(dir)], {
      encoding: "utf8",
      env: {
        ...process.env,
        DEVPRO_DIFF_ACTIVE_CHANGES: `${ACTIVE},${second}`,
        DEVPRO_RELEVANT_ARCHIVES: ARCHIVED,
      },
    });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}\n${r.stdout}`);
    assert.match(
      r.stdout,
      new RegExp(`^ {2}changes {2}: ${ACTIVE}, ${second}$`, "m"),
      "the named skip must name every owned active change",
    );
    assert.doesNotMatch(r.stdout, /currency is ok/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--pre-review keeps the R6 receipt assertion fail-closed when identity is unknown", () => {
  // Only positive consumer evidence unlocks the skip; an unknown repository
  // stays on the fail-closed path, where a missing receipt is still exit 1.
  const dir = fixture({
    attestationIn: "active",
    identity: "unknown",
    regressionHead: "missing",
    boundedCarriers: false,
  });
  try {
    const r = runGate(dir, ["--pre-review"]);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}\n${r.stdout}`);
    assert.match(r.stderr, /has not been recorded green at the current HEAD/);
    assert.match(r.stderr, /an unrecorded suite run is not evidence about this tree/);
    assert.doesNotMatch(r.stdout, /skipping the source-maintainer/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--pre-review does not consume an existing consumer receipt (stale stays non-evidence)", () => {
  // The consumer path never reads notes/qa-regression-head-<change>.json: a
  // stale receipt present in the fixture must not change the named skip or the
  // exit code. A consumed stale receipt would produce the fail-closed block
  // asserted absent below.
  const dir = fixture({
    attestationIn: "active",
    identity: "consumer",
    regressionHead: "stale",
    boundedCarriers: false,
  });
  try {
    const r = runGate(dir, ["--pre-review"]);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}\n${r.stdout}`);
    assert.match(r.stdout, /skipping the source-maintainer canonical-suite regression-head receipt assertion \(R6\)/);
    assert.match(r.stdout, /^ {2}identity : consumer \(direct adoption evidence\)$/m);
    assert.match(r.stdout, /^ {2}changes {2}: pre-review-change$/m);
    assert.doesNotMatch(r.stdout, /currency is ok/);
    assert.doesNotMatch(r.stderr, /has not been recorded green at the current HEAD/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no owned active change is a visible pass, not a silent skip (rules branch / chore-A)", () => {
  // A rules branch reaches --pre-review with nothing owned; line 591 already
  // exempts it from the blocking-owned check. Failing closed here would block
  // a path the gate deliberately supports, and there is no change name to key
  // a receipt on. It must still SAY so.
  const dir = fixture({ attestationIn: "active", regressionHead: "missing", boundedCarriers: false });
  try {
    const r = spawnSync("node", [GATE, dir, "--pre-review"], {
      encoding: "utf8",
      env: { ...process.env, DEVPRO_DIFF_ACTIVE_CHANGES: "", DEVPRO_RELEVANT_ARCHIVES: ARCHIVED },
    });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}\n${r.stdout}`);
    assert.match(r.stdout, /No owned active change, so no regression-head receipt is keyed to assert \(R6\)/);
    assert.match(r.stdout, /not a skipped check/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--pre-review does not filter an owned active symlink before BRD classification", () => {
  const dir = fixture({ attestationIn: "active", regressionHead: "current", boundedCarriers: false });
  const outside = makeTempDir("archive-gate-owned-symlink-");
  try {
    const active = path.join(dir, "openspec", "changes", ACTIVE);
    rmSync(active, { recursive: true, force: true });
    symlinkSync(outside, active, "dir");

    const r = runGate(dir, ["--pre-review"]);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}\n${r.stdout}`);
    assert.match(r.stderr, /archive-candidate-invalid/);
    assert.match(r.stderr, new RegExp(ACTIVE));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("--pre-review does not filter an owned active non-directory before BRD classification", () => {
  const dir = fixture({ attestationIn: "active", regressionHead: "current", boundedCarriers: false });
  try {
    const active = path.join(dir, "openspec", "changes", ACTIVE);
    rmSync(active, { recursive: true, force: true });
    writeFileSync(active, "not a change directory\n");

    const r = runGate(dir, ["--pre-review"]);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}\n${r.stdout}`);
    assert.match(r.stderr, /archive-candidate-invalid/);
    assert.match(r.stderr, new RegExp(ACTIVE));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every owned active change is asserted, not just the first", () => {
  // A branch owning two active changes that reads one receipt would pass while
  // the second change's suite was never run at this HEAD.
  const dir = fixture({ attestationIn: "active", regressionHead: "current" });
  try {
    const second = "pre-review-change-two";
    mkdirSync(path.join(dir, "openspec/changes", second), { recursive: true });
    // No second attestation: gate (e) wants exactly one across the owned set,
    // and this test is about the regression-head loop, not about topology.
    writeFileSync(path.join(dir, "openspec/changes", second, "proposal.md"), PROPOSAL_BASE);
    writeFileSync(path.join(dir, "openspec/changes", second, "brd.md"), VALID_BRD);
    writeFileSync(
      path.join(dir, "openspec/changes", second, "tasks.md"),
      "## Tasks\n\n" +
        "- [x] **T1 — Fixture task.** Cover the fixture ledger row. [Req: R1]\n" +
        "  - 驗收: fixture R1 covered\n",
    );
    writeFileSync(
      path.join(dir, "openspec/changes", second, "decisions.md"),
      "## Requirement Baseline Ledger\n" +
        "| decision_id | trigger | baseline_from | baseline_to |\n" +
        "|---|---|---|---|\n" +
        "| D1 | initial | 0 | 1 |\n\n" +
        "## D1: fixture baseline\n",
    );
    const r = spawnSync("node", [GATE, dir, "--pre-review", "--change-base-ref", changeBaseOf(dir)], {
      encoding: "utf8",
      env: {
        ...process.env,
        DEVPRO_DIFF_ACTIVE_CHANGES: `${ACTIVE},${second}`,
        DEVPRO_RELEVANT_ARCHIVES: ARCHIVED,
      },
    });
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stdout}`);
    assert.match(r.stderr, new RegExp(`change "${second}": no receipt`));
    assert.doesNotMatch(r.stderr, new RegExp(`change "${ACTIVE}":`), "the covered change must not be reported");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--pre-review fails closed when named-definition corpus-grep evidence section is absent (#2526)", () => {
  const dir = fixture({ attestationIn: "active", boundedCarriers: false });
  try {
    const proposalPath = path.join(dir, "openspec/changes", ACTIVE, "proposal.md");
    const stripped = PROPOSAL_BASE.replace(
      /## Named-Definition Corpus-Grep Evidence[\s\S]*$/,
      "",
    );
    assert.doesNotMatch(stripped, /Named-Definition Corpus-Grep Evidence/);
    writeFileSync(proposalPath, stripped);
    git(dir, ["add", "openspec/changes"]);
    git(dir, ["commit", "-q", "-m", "strip corpus-grep evidence"]);
    const head = git(dir, ["rev-parse", "HEAD"]).stdout.trim();
    writeRegressionHeadRecord({ cwd: dir, change: ACTIVE, headSha: head, branch: "main",
      suiteEvidence: PASS_SUITE_EVIDENCE,
    });
    const r = runGate(dir, ["--pre-review"]);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}\n${r.stdout}`);
    assert.match(r.stderr, /named-definition corpus-grep evidence/i);
    assert.match(r.stderr, /section-missing/);
    assert.match(r.stderr, /Named-Definition Corpus-Grep Evidence/);
    assert.match(
      r.stderr,
      /definitions needing evidence: \(undeclared — section absent\)/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--pre-review fails closed when present evidence omits definition fields (#2526)", () => {
  const dir = fixture({ attestationIn: "active", boundedCarriers: false });
  try {
    const proposalPath = path.join(dir, "openspec/changes", ACTIVE, "proposal.md");
    const incomplete = PROPOSAL_BASE.replace(
      /## Named-Definition Corpus-Grep Evidence[\s\S]*$/,
      [
        "## Named-Definition Corpus-Grep Evidence",
        "",
        "```json",
        JSON.stringify(
          {
            status: "present",
            definitions: [
              {
                name: "fixture_named_def",
                scope: "",
                hits: "",
                disposition: "",
              },
            ],
          },
          null,
          2,
        ),
        "```",
        "",
      ].join("\n"),
    );
    writeFileSync(proposalPath, incomplete);
    git(dir, ["add", "openspec/changes"]);
    git(dir, ["commit", "-q", "-m", "incomplete corpus-grep evidence"]);
    const head = git(dir, ["rev-parse", "HEAD"]).stdout.trim();
    writeRegressionHeadRecord({ cwd: dir, change: ACTIVE, headSha: head, branch: "main",
      suiteEvidence: PASS_SUITE_EVIDENCE,
    });
    const r = runGate(dir, ["--pre-review"]);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}\n${r.stdout}`);
    assert.match(r.stderr, /definition-fields-incomplete/);
    assert.match(r.stderr, /definitions needing evidence: fixture_named_def/);
    assert.match(r.stderr, /missing scope, disposition, hits\|results/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--pre-review fails closed when --change-base-ref is missing for an owned full change", () => {
  const dir = fixture({ attestationIn: "active", boundedCarriers: false });
  try {
    const r = spawnSync("node", [GATE, dir, "--pre-review"], {
      encoding: "utf8",
      env: {
        ...process.env,
        DEVPRO_DIFF_ACTIVE_CHANGES: ACTIVE,
        DEVPRO_RELEVANT_ARCHIVES: ARCHIVED,
      },
    });
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}\n${r.stdout}`);
    assert.match(r.stderr, /requires --change-base-ref/);
    assert.match(r.stderr, /MUST NOT substitute --baseline-ref/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--pre-review exits 1 on ADDED existing requirement before reviewer dispatch (R10 RED)", () => {
  const dir = fixture({ attestationIn: "active", boundedCarriers: false });
  try {
    const cap = "fixture-cap";
    const reqTitle = "Fixture Existing Requirement";
    mkdirSync(path.join(dir, "openspec/specs", cap), { recursive: true });
    writeFileSync(
      path.join(dir, "openspec/specs", cap, "spec.md"),
      `### Requirement: ${reqTitle}\n\n` +
        `The fixture SHALL keep this requirement in canonical.\n\n` +
        `#### Scenario: Fixture Canonical Scenario\n\n` +
        `- **WHEN** the fixture runs\n` +
        `- **THEN** the canonical requirement exists\n`,
    );
    mkdirSync(path.join(dir, "openspec/changes", ACTIVE, "specs", cap), { recursive: true });
    writeFileSync(
      path.join(dir, "openspec/changes", ACTIVE, "specs", cap, "spec.md"),
      `## ADDED Requirements\n\n` +
        `### Requirement: ${reqTitle}\n\n` +
        `The fixture SHALL keep this requirement in canonical.\n\n` +
        `#### Scenario: Fixture Canonical Scenario\n\n` +
        `- **WHEN** the fixture runs\n` +
        `- **THEN** the canonical requirement exists\n`,
    );
    git(dir, ["add", "openspec"]);
    git(dir, ["commit", "-q", "-m", "RED: ADDED existing requirement"]);
    const head = git(dir, ["rev-parse", "HEAD"]).stdout.trim();
    writeRegressionHeadRecord({
      cwd: dir,
      change: ACTIVE,
      headSha: head,
      branch: "main",
      suiteEvidence: PASS_SUITE_EVIDENCE,
    });
    const r = runGate(dir, ["--pre-review"]);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}\n${r.stdout}`);
    assert.match(r.stderr, /active content lint failed before reviewer dispatch/);
    assert.match(r.stderr, /lint\s*:\s*lint-delta-requirement-mode/);
    assert.match(r.stderr, new RegExp(`change\\s*:\\s*${ACTIVE}`));
    assert.match(r.stderr, /ADDED Requirement/);
    assert.doesNotMatch(r.stdout, /Active content lints asserted/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--pre-review exits 1 on a REMOVED block that is not verbatim canonical before reviewer dispatch", () => {
  const dir = fixture({ attestationIn: "active", boundedCarriers: false });
  try {
    const cap = "fixture-cap";
    const reqTitle = "Fixture Retired Requirement";
    mkdirSync(path.join(dir, "openspec/specs", cap), { recursive: true });
    writeFileSync(
      path.join(dir, "openspec/specs", cap, "spec.md"),
      `### Requirement: ${reqTitle}\n\n` +
        `The fixture SHALL keep this requirement in canonical until archive.\n\n` +
        `#### Scenario: Fixture Canonical Scenario\n\n` +
        `- **WHEN** the fixture runs\n` +
        `- **THEN** the canonical requirement exists\n`,
    );
    mkdirSync(path.join(dir, "openspec/changes", ACTIVE, "specs", cap), { recursive: true });
    writeFileSync(
      path.join(dir, "openspec/changes", ACTIVE, "specs", cap, "spec.md"),
      `## REMOVED Requirements\n\n` +
        `### Requirement: ${reqTitle}\n\n` +
        `**Reason**: retired.\n` +
        `**Migration**: none.\n`,
    );
    git(dir, ["add", "openspec"]);
    git(dir, ["commit", "-q", "-m", "RED: REMOVED block is a Reason summary, not the canonical body"]);
    const head = git(dir, ["rev-parse", "HEAD"]).stdout.trim();
    writeRegressionHeadRecord({
      cwd: dir,
      change: ACTIVE,
      headSha: head,
      branch: "main",
      suiteEvidence: PASS_SUITE_EVIDENCE,
    });
    const r = runGate(dir, ["--pre-review"]);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}\n${r.stdout}`);
    assert.match(r.stderr, /active content lint failed before reviewer dispatch/);
    assert.match(r.stderr, /lint\s*:\s*lint-delta-requirement-mode/);
    assert.match(r.stderr, new RegExp(`change\\s*:\\s*${ACTIVE}`));
    assert.match(r.stderr, /REMOVED Requirement "Fixture Retired Requirement" body is not verbatim equal/);
    assert.doesNotMatch(r.stdout, /Active content lints asserted/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--pre-review exits 1 when a scenario is renamed in delta and canonical together (#2978)", () => {
  const dir = fixture({ attestationIn: "active", boundedCarriers: false });
  try {
    const cap = "fixture-cap";
    const reqTitle = "Fixture Existing Requirement";
    const requirementWith = (scenarioTitle) =>
      `### Requirement: ${reqTitle}\n\n` +
      `The fixture SHALL keep this requirement in canonical.\n\n` +
      `#### Scenario: Fixture Kept Scenario\n\n` +
      `- **WHEN** the fixture runs\n` +
      `- **THEN** the canonical requirement exists\n\n` +
      `#### Scenario: ${scenarioTitle}\n\n` +
      `- **WHEN** the fixture is invalid\n` +
      `- **THEN** the fixture is rejected\n`;
    mkdirSync(path.join(dir, "openspec/specs", cap), { recursive: true });
    writeFileSync(path.join(dir, "openspec/specs", cap, "spec.md"), requirementWith("Fixture Old Title"));
    git(dir, ["add", "openspec"]);
    git(dir, ["commit", "-q", "-m", "change base with the canonical scenario"]);
    const changeBase = git(dir, ["rev-parse", "HEAD"]).stdout.trim();
    // The change itself renames the scenario in canonical AND in the delta.
    writeFileSync(path.join(dir, "openspec/specs", cap, "spec.md"), requirementWith("Fixture New Title"));
    mkdirSync(path.join(dir, "openspec/changes", ACTIVE, "specs", cap), { recursive: true });
    writeFileSync(
      path.join(dir, "openspec/changes", ACTIVE, "specs", cap, "spec.md"),
      `## MODIFIED Requirements\n\n${requirementWith("Fixture New Title")}`,
    );
    git(dir, ["add", "openspec"]);
    git(dir, ["commit", "-q", "-m", "rename the scenario on both sides"]);
    const head = git(dir, ["rev-parse", "HEAD"]).stdout.trim();
    writeRegressionHeadRecord({
      cwd: dir,
      change: ACTIVE,
      headSha: head,
      branch: "main",
      suiteEvidence: PASS_SUITE_EVIDENCE,
    });
    const r = runGate(dir, ["--pre-review", "--change-base-ref", changeBase]);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}\n${r.stdout}`);
    assert.match(r.stderr, /active content lint failed before reviewer dispatch/);
    assert.match(r.stderr, /lint\s*:\s*lint-modified-scenario-preservation/);
    assert.match(r.stderr, /Fixture Old Title/);
    assert.doesNotMatch(r.stdout, /Active content lints asserted/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--pre-review passes when the same requirement is complete MODIFIED (R10 GREEN)", () => {
  const dir = fixture({ attestationIn: "active", boundedCarriers: false });
  try {
    const cap = "fixture-cap";
    const reqTitle = "Fixture Existing Requirement";
    const body =
      `### Requirement: ${reqTitle}\n\n` +
      `The fixture SHALL keep this requirement in canonical.\n\n` +
      `#### Scenario: Fixture Canonical Scenario\n\n` +
      `- **WHEN** the fixture runs\n` +
      `- **THEN** the canonical requirement exists\n`;
    mkdirSync(path.join(dir, "openspec/specs", cap), { recursive: true });
    writeFileSync(path.join(dir, "openspec/specs", cap, "spec.md"), body);
    mkdirSync(path.join(dir, "openspec/changes", ACTIVE, "specs", cap), { recursive: true });
    writeFileSync(
      path.join(dir, "openspec/changes", ACTIVE, "specs", cap, "spec.md"),
      `## MODIFIED Requirements\n\n${body}`,
    );
    git(dir, ["add", "openspec"]);
    git(dir, ["commit", "-q", "-m", "GREEN: MODIFIED existing requirement"]);
    const head = git(dir, ["rev-parse", "HEAD"]).stdout.trim();
    writeRegressionHeadRecord({
      cwd: dir,
      change: ACTIVE,
      headSha: head,
      branch: "main",
      suiteEvidence: PASS_SUITE_EVIDENCE,
    });
    const r = runGate(dir, ["--pre-review"]);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}\n${r.stdout}`);
    assert.match(r.stdout, /Active content lints asserted for pre-review-change/);
    assert.match(r.stdout, /requirement-mode, scenario-preservation/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// strengthen-pre-archive-promotion-lint — promote-time defects in the active
// delta must red at --pre-review, and the source-only delta-citation lint
// (lint-delta-spec-citations) is source-maintainer-only.
const CITATION_CAP = "fixture-cap";
const CITATION_REQ = "Fixture Citation Requirement";

/** Commit an ADDED-only delta whose THEN line is `thenLine`, then re-record the receipt at the new HEAD. */
function commitCitationDelta(dir, thenLine, { agentRulesLeaf = false } = {}) {
  if (agentRulesLeaf) {
    // A consumer fixture has no source corpus; give the citation lint a rules
    // directory so a lint that wrongly runs there would have something to red on.
    mkdirSync(path.join(dir, ".devpro/agent-rules"), { recursive: true });
    writeFileSync(path.join(dir, ".devpro/agent-rules/fixture-leaf.md"), "# Fixture Leaf\n\n## Present Heading\n");
  }
  mkdirSync(path.join(dir, "openspec/changes", ACTIVE, "specs", CITATION_CAP), { recursive: true });
  writeFileSync(
    path.join(dir, "openspec/changes", ACTIVE, "specs", CITATION_CAP, "spec.md"),
    `## ADDED Requirements\n\n` +
      `### Requirement: ${CITATION_REQ}\n\n` +
      `The fixture SHALL cite a rule leaf.\n\n` +
      `#### Scenario: Fixture Citation Scenario\n\n` +
      `- **WHEN** the fixture runs\n` +
      `${thenLine}\n`,
  );
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "fixture: delta with a THEN citation"]);
  const head = git(dir, ["rev-parse", "HEAD"]).stdout.trim();
  writeRegressionHeadRecord({ cwd: dir, change: ACTIVE, headSha: head, branch: "main", suiteEvidence: PASS_SUITE_EVIDENCE });
}

const ASSERTED_LINE = /^Active content lints asserted for .*$/m;

test("Pre-Review Blocks Promote-Time Defects In The Active Delta — unresolvable THEN citation names lint-delta-spec-citations", () => {
  const dir = fixture({ attestationIn: "active", boundedCarriers: false });
  try {
    commitCitationDelta(dir, "- **THEN** it follows `no-such-leaf.md` §Present Heading");
    const r = runGate(dir, ["--pre-review"]);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}\n${r.stdout}`);
    assert.match(r.stderr, /active content lint failed before reviewer dispatch/);
    assert.match(r.stderr, /lint\s*:\s*lint-delta-spec-citations/);
    assert.match(r.stderr, new RegExp(`change\\s*:\\s*${ACTIVE}`));
    assert.match(r.stderr, /unresolved leaf/);
    assert.doesNotMatch(r.stdout, /Active content lints asserted/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Pre-Review Blocks Promote-Time Defects In The Active Delta — undeclared REMOVED scenario names lint-modified-scenario-preservation", () => {
  const dir = fixture({ attestationIn: "active", boundedCarriers: false });
  try {
    const body =
      `### Requirement: Fixture Retired Requirement\n\n` +
      `The fixture SHALL keep this requirement in canonical until archive.\n\n` +
      `#### Scenario: Fixture Canonical Scenario\n\n` +
      `- **WHEN** the fixture runs\n` +
      `- **THEN** the canonical requirement exists\n`;
    mkdirSync(path.join(dir, "openspec/specs", CITATION_CAP), { recursive: true });
    writeFileSync(path.join(dir, "openspec/specs", CITATION_CAP, "spec.md"), body);
    mkdirSync(path.join(dir, "openspec/changes", ACTIVE, "specs", CITATION_CAP), { recursive: true });
    writeFileSync(
      path.join(dir, "openspec/changes", ACTIVE, "specs", CITATION_CAP, "spec.md"),
      `## REMOVED Requirements\n\n${body}`,
    );
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "fixture: REMOVED requirement with an undeclared scenario"]);
    const head = git(dir, ["rev-parse", "HEAD"]).stdout.trim();
    writeRegressionHeadRecord({ cwd: dir, change: ACTIVE, headSha: head, branch: "main", suiteEvidence: PASS_SUITE_EVIDENCE });
    const r = runGate(dir, ["--pre-review"]);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}\n${r.stdout}`);
    assert.match(r.stderr, /lint\s*:\s*lint-modified-scenario-preservation/);
    assert.match(r.stderr, new RegExp(`change\\s*:\\s*${ACTIVE}`));
    assert.match(r.stderr, /Fixture Canonical Scenario/);
    assert.doesNotMatch(r.stdout, /Active content lints asserted/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Pre-Review Lists All Eight Content Lints When They Pass", () => {
  const dir = fixture({ attestationIn: "active", boundedCarriers: false });
  try {
    commitCitationDelta(dir, "- **THEN** it follows `rule-audit-playbook.md` §sentinel");
    const r = runGate(dir, ["--pre-review"]);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}\n${r.stdout}`);
    const line = r.stdout.match(ASSERTED_LINE)?.[0] ?? "";
    for (const name of [
      "requirement-mode",
      "scenario-preservation",
      "delta-body-canonical-wrap",
      "proposal-tasks-checked",
      "proposal-touch-self-path",
      "proposal-touch-coverage",
      "requirement-count-ratchet",
      "delta-spec-citations",
    ]) {
      assert.ok(line.includes(name), `asserted line missing ${name}: ${line}`);
    }
    assert.match(line, /\(R10; --change-base-ref [0-9a-f]+\)\.$/);
    assert.doesNotMatch(r.stdout, /source-maintainer-only.*delta-spec-citations|delta-spec-citations.*source-maintainer/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Consumer Identity Skips The Delta Citation Lint With A Named Line", () => {
  const dir = fixture({
    attestationIn: "active",
    identity: "consumer",
    regressionHead: "missing",
    boundedCarriers: false,
  });
  try {
    // A citation that the source lint would block: the consumer must still exit 0.
    commitCitationDelta(dir, "- **THEN** it follows `no-such-leaf.md` §Nowhere", { agentRulesLeaf: true });
    const r = runGate(dir, ["--pre-review"]);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}\n${r.stdout}`);
    const skipLines = r.stdout.split("\n").filter((l) => l.includes("delta-spec-citations"));
    assert.ok(skipLines.length >= 1, `no named skip line:\n${r.stdout}`);
    const skipBlock = skipLines.join("\n");
    assert.match(skipBlock, /source-maintainer/);
    assert.doesNotMatch(skipBlock, /asserted/);
    assert.match(r.stdout, new RegExp(`${ACTIVE}`));
    // Exactly one skip line; it names the change.
    assert.equal(skipLines.length, 1, skipBlock);
    assert.ok(skipLines[0].includes(ACTIVE), skipLines[0]);
    // The asserted line lists the other six and not the skipped lint.
    const line = r.stdout.match(ASSERTED_LINE)?.[0] ?? "";
    assert.ok(line.length > 0, `asserted line missing:\n${r.stdout}`);
    assert.doesNotMatch(line, /delta-spec-citations/);
    for (const name of [
      "requirement-mode",
      "scenario-preservation",
      "delta-body-canonical-wrap",
      "proposal-tasks-checked",
      "proposal-touch-self-path",
      "proposal-touch-coverage",
      "requirement-count-ratchet",
    ]) {
      assert.ok(line.includes(name), `asserted line missing ${name}: ${line}`);
    }
    assert.match(line, /\(R10; --change-base-ref [0-9a-f]+\)\.$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Consumer Identity Skips The Delta Citation Lint With A Named Line — the other content lints still block", () => {
  const dir = fixture({
    attestationIn: "active",
    identity: "consumer",
    regressionHead: "missing",
    boundedCarriers: false,
  });
  try {
    // ADDED of an already-canonical requirement: lint-delta-requirement-mode must still red.
    const body =
      `### Requirement: ${CITATION_REQ}\n\nThe fixture SHALL keep this.\n\n` +
      `#### Scenario: Fixture Citation Scenario\n\n- **WHEN** x\n- **THEN** y\n`;
    mkdirSync(path.join(dir, "openspec/specs", CITATION_CAP), { recursive: true });
    writeFileSync(path.join(dir, "openspec/specs", CITATION_CAP, "spec.md"), body);
    mkdirSync(path.join(dir, "openspec/changes", ACTIVE, "specs", CITATION_CAP), { recursive: true });
    writeFileSync(path.join(dir, "openspec/changes", ACTIVE, "specs", CITATION_CAP, "spec.md"), `## ADDED Requirements\n\n${body}`);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "fixture: consumer ADDED existing requirement"]);
    const r = runGate(dir, ["--pre-review"]);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}\n${r.stdout}`);
    assert.match(r.stderr, /lint\s*:\s*lint-delta-requirement-mode/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Unknown identity still runs the delta citation lint", () => {
  const dir = fixture({ attestationIn: "active", identity: "unknown", boundedCarriers: false });
  try {
    commitCitationDelta(dir, "- **THEN** it follows `no-such-leaf.md` §Nowhere", { agentRulesLeaf: true });
    const r = runGate(dir, ["--pre-review"]);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}\n${r.stdout}`);
    assert.match(r.stderr, /lint\s*:\s*lint-delta-spec-citations/);
    assert.match(r.stderr, /unresolved leaf/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const PROVE_IT_TASKS_BODY =
  "## Tasks\n\n" +
  "- [x] **T1 — Prove-it test.** Write the failing test that reproduces the bug first. [Req: R1]\n" +
  "  - 驗收: prove-it test is RED before the fix\n" +
  "- [x] **T2 — Fix.** Make the prove-it test pass. [Req: R1]\n" +
  "  - 驗收: prove-it test is GREEN\n";

test("--pre-review fails closed on a bugfix branch whose active task ledger has no prove-it marker (#2985)", () => {
  const dir = fixture({ attestationIn: "active", boundedCarriers: false });
  try {
    const r = runGate(dir, ["--pre-review"], { DEVPRO_CURRENT_BRANCH: "bugfix/fixture-bug" });
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}\n${r.stdout}`);
    assert.match(r.stderr, /Pre-PR archive gate \(l\)/);
    assert.match(r.stderr, /active change folder openspec[\\/]changes[\\/]pre-review-change/);
    assert.match(r.stderr, /未包含 prove-it test task/);
    assert.match(r.stderr, /--pre-review 的提前檢查/);
    assert.doesNotMatch(r.stdout, /Bugfix prove-it task asserted/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--pre-review passes a bugfix branch whose active task ledger carries a prove-it marker (#2985)", () => {
  const dir = fixture({ attestationIn: "active", boundedCarriers: false, tasksBody: PROVE_IT_TASKS_BODY });
  try {
    const r = runGate(dir, ["--pre-review"], { DEVPRO_CURRENT_BRANCH: "bugfix/fixture-bug" });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}\n${r.stdout}`);
    assert.match(r.stdout, /Bugfix prove-it task asserted for pre-review-change/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--pre-review does not ask a non-bugfix branch for a prove-it marker (#2985)", () => {
  const dir = fixture({ attestationIn: "active", boundedCarriers: false });
  try {
    for (const branch of ["feature/fixture-feature", "chore/fixture-chore"]) {
      const r = runGate(dir, ["--pre-review"], { DEVPRO_CURRENT_BRANCH: branch });
      assert.equal(r.status, 0, `${branch}: expected exit 0, got ${r.status}: ${r.stderr}\n${r.stdout}`);
      assert.doesNotMatch(r.stdout, /Bugfix prove-it task asserted/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--pre-review names the missing task-ledger carrier on a bugfix branch (#2985)", () => {
  const dir = fixture({ attestationIn: "active", boundedCarriers: false, tasksBody: PROVE_IT_TASKS_BODY });
  try {
    rmSync(path.join(dir, "openspec/changes", ACTIVE, "tasks.md"));
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "drop the task ledger"]);
    writeRegressionHeadRecord({
      cwd: dir,
      change: ACTIVE,
      headSha: git(dir, ["rev-parse", "HEAD"]).stdout.trim(),
      branch: "main",
      suiteEvidence: PASS_SUITE_EVIDENCE,
    });
    const r = runGate(dir, ["--pre-review"], { DEVPRO_CURRENT_BRANCH: "bugfix/fixture-bug" });
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}\n${r.stdout}`);
    assert.match(r.stderr, /Pre-PR archive gate \(l\)/);
    assert.match(r.stderr, /active change folder openspec[\\/]changes[\\/]pre-review-change 缺少 task-ledger carrier/);
    assert.doesNotMatch(r.stdout, /Bugfix prove-it task asserted/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── lite batch scope record (`lite-scope.md`) coexistence with OpenSpec tools ──
//
// A lite batch writes one gitignored line at `openspec/changes/<name>/lite-scope.md`
// and never archives it, so a folder holding only that record is not an
// un-archived change. The shared classifier is the single place that knows the
// shape; gate (a) and `--pre-review` (j) consume its verdict.

const LITE_RECORD = "kind=same-change-dp-change-batch; named_change=pre-review-change\n";
const LITE_SIDE_DIRS = ["admission-records", "override-ledger"];

// Rebuilds the fixture's active change folder as a lite folder: no proposal
// carrier, no task ledger, only the record. Returns the fixture root.
function liteFixture({ extra = () => {} } = {}) {
  const dir = fixture({ attestationIn: "active", regressionHead: "missing", boundedCarriers: false, activeBrd: null });
  const active = path.join(dir, "openspec", "changes", ACTIVE);
  rmSync(active, { recursive: true, force: true });
  mkdirSync(active, { recursive: true });
  writeFileSync(path.join(active, "lite-scope.md"), LITE_RECORD);
  extra(active);
  return dir;
}

const LITE_BRANCH_ENV = { DEVPRO_CURRENT_BRANCH: `feature/${ACTIVE}` };

function withLiteDirectory(arrange, check) {
  const root = makeTempDir("lite-scope-class-");
  const dir = path.join(root, "change");
  mkdirSync(dir);
  try {
    arrange(dir);
    check(dir);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("Owned Proven-Lite Folder Does Not Block Case (a)", () => {
  // classifier verdict: record only, then record plus both untracked side dirs
  withLiteDirectory((dir) => writeFileSync(path.join(dir, "lite-scope.md"), LITE_RECORD), (dir) => {
    const verdict = classifyExistingBrdDirectory(dir);
    assert.deepEqual(
      { ok: verdict.ok, applicability: verdict.applicability, reason: verdict.reason },
      { ok: true, applicability: "not-applicable", reason: "proven-lite" },
    );
  });
  withLiteDirectory((dir) => {
    writeFileSync(path.join(dir, "lite-scope.md"), LITE_RECORD);
    for (const side of LITE_SIDE_DIRS) mkdirSync(path.join(dir, side));
  }, (dir) => {
    const verdict = classifyExistingBrdDirectory(dir);
    assert.equal(verdict.reason, "proven-lite");
    assert.equal(verdict.ok, true);
  });

  // gate (a), owned by branch suffix and by the diff-active override
  for (const withSideDirs of [false, true]) {
    const dir = liteFixture({
      extra: (active) => { if (withSideDirs) for (const side of LITE_SIDE_DIRS) mkdirSync(path.join(active, side)); },
    });
    try {
      const r = runGate(dir, [], LITE_BRANCH_ENV);
      assert.doesNotMatch(r.stderr, /Active change folder still exists/, `withSideDirs=${withSideDirs}: ${r.stderr}`);
      assert.doesNotMatch(r.stderr, /chore\/docs-archive-/, `withSideDirs=${withSideDirs}: rescue hint must not appear`);
      assert.doesNotMatch(r.stderr, /artifact-class-unknown|lite-scope-with-proposal/);
      const info = r.stdout.split("\n").filter((line) => line.includes("proven-lite"));
      assert.equal(info.length, 1, `withSideDirs=${withSideDirs}: expected exactly one proven-lite line, got:\n${r.stdout}`);
      assert.ok(info[0].includes(ACTIVE), `informational line must name the folder: ${info[0]}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("Lite Scope Record Next To A Proposal Fails Closed", () => {
  for (const carrier of ["proposal.md", "proposal-mini.md"]) {
    withLiteDirectory((dir) => {
      writeFileSync(path.join(dir, "lite-scope.md"), LITE_RECORD);
      writeFileSync(path.join(dir, carrier), "x");
    }, (dir) => {
      const verdict = classifyExistingBrdDirectory(dir);
      assert.equal(verdict.ok, false, carrier);
      assert.equal(verdict.code, "lite-scope-with-proposal", carrier);
      assert.notEqual(verdict.reason, "proven-lite");
    });
  }

  // gate (a): the folder stays blocking and the message names the code
  const dir = liteFixture({
    extra: (active) => writeFileSync(path.join(active, "proposal.md"), PROPOSAL_BASE),
  });
  try {
    const r = runGate(dir, [], LITE_BRANCH_ENV);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}\n${r.stdout}`);
    assert.match(r.stderr, new RegExp(`Active change folder still exists: ${ACTIVE}`));
    assert.match(r.stderr, /lite-scope-with-proposal/);
    assert.doesNotMatch(r.stdout, /proven-lite/);

    // gate (j): fails closed naming the folder and the code before any dispatch
    const pre = runGate(dir, ["--pre-review"], LITE_BRANCH_ENV);
    assert.equal(pre.status, 1, `expected exit 1, got ${pre.status}: ${pre.stderr}\n${pre.stdout}`);
    assert.match(pre.stderr, new RegExp(ACTIVE));
    assert.match(pre.stderr, /lite-scope-with-proposal/);
    // the (j) detail names the fix, not only the generic "cannot be proven"
    assert.match(pre.stderr, /delete lite-scope\.md/);
    assert.match(pre.stderr, /## Batch Approval Ledger/);
    assert.doesNotMatch(pre.stderr, /artifact class or carrier cannot be proven/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Tracked Docs Next To A Lite Record Stay Proven-Lite", () => {
  // 2026-10-24 之後的缺口：歸檔時帶已追蹤設計文件或 spec delta 的 lite change，
  // (j) 一律 artifact-class-unknown。`lite-scope.md` 本身就是 marker，同資料夾的
  // 已追蹤檔案不改變這個判斷。
  for (const [name, arrange] of [
    ["lite-scope.md plus brd.md", (dir) => writeFileSync(path.join(dir, "brd.md"), VALID_BRD)],
    ["lite-scope.md plus specs/", (dir) => { mkdirSync(path.join(dir, "specs")); writeFileSync(path.join(dir, "specs", "spec.md"), "x"); }],
    ["lite-scope.md plus design.md", (dir) => writeFileSync(path.join(dir, "design.md"), "design")],
  ]) {
    withLiteDirectory((dir) => {
      writeFileSync(path.join(dir, "lite-scope.md"), LITE_RECORD);
      arrange(dir);
    }, (dir) => {
      const verdict = classifyExistingBrdDirectory(dir);
      assert.equal(verdict.ok, true, name);
      assert.equal(verdict.reason, "proven-lite", name);
    });
  }
});

test("Other Proposal-Less Folder Shapes Stay Artifact-Class-Unknown", () => {
  const shapes = [
    ["lite-scope.md is a symlink", (dir) => {
      writeFileSync(path.join(dir, "target.txt"), LITE_RECORD);
      symlinkSync("target.txt", path.join(dir, "lite-scope.md"));
    }],
    ["lite-scope.md is a directory", (dir) => mkdirSync(path.join(dir, "lite-scope.md"))],
    ["only admission-records/", (dir) => mkdirSync(path.join(dir, "admission-records"))],
    ["admission-records/ and override-ledger/ but no record", (dir) => {
      for (const side of LITE_SIDE_DIRS) mkdirSync(path.join(dir, side));
    }],
  ];
  for (const [name, arrange] of shapes) {
    withLiteDirectory(arrange, (dir) => {
      const verdict = classifyExistingBrdDirectory(dir);
      assert.equal(verdict.ok, false, name);
      assert.equal(verdict.code, "artifact-class-unknown", name);
      assert.notEqual(verdict.reason, "proven-lite", name);
    });
  }

  // gate (a) keeps each owned shape blocking with the code named
  for (const [name, arrange] of [
    ["lite-scope.md is a symlink", (active) => {
      rmSync(path.join(active, "lite-scope.md"));
      writeFileSync(path.join(active, "target.txt"), LITE_RECORD);
      symlinkSync("target.txt", path.join(active, "lite-scope.md"));
    }],
    ["only admission-records/", (active) => {
      rmSync(path.join(active, "lite-scope.md"));
      mkdirSync(path.join(active, "admission-records"));
    }],
  ]) {
    const dir = liteFixture({ extra: arrange });
    try {
      const r = runGate(dir, [], LITE_BRANCH_ENV);
      assert.equal(r.status, 1, `${name}: expected exit 1, got ${r.status}: ${r.stderr}\n${r.stdout}`);
      assert.match(r.stderr, new RegExp(`Active change folder still exists: ${ACTIVE}`), name);
      assert.match(r.stderr, /artifact-class-unknown/, name);
      assert.doesNotMatch(r.stdout, /proven-lite/, name);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("Pre-Review Drops A Proven-Lite Folder Like Proven Chore A", () => {
  const dir = liteFixture();
  try {
    // No --change-base-ref (runGate would add one for us), no regression-head
    // record: a proven-lite folder keys nothing to assert.
    const r = spawnSync("node", [GATE, dir, "--pre-review"], {
      encoding: "utf8",
      env: {
        ...process.env,
        DEVPRO_DIFF_ACTIVE_CHANGES: ACTIVE,
        DEVPRO_RELEVANT_ARCHIVES: ARCHIVED,
        ...LITE_BRANCH_ENV,
      },
    });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}\n${r.stdout}`);
    assert.doesNotMatch(r.stderr, /--change-base-ref/);
    assert.match(r.stdout, /No owned active change, so no regression-head receipt is keyed to assert \(R6\)/);
    assert.doesNotMatch(r.stdout, /Regression-head receipt asserted for/);
    assert.doesNotMatch(r.stdout, /Active content lints asserted for/);
    assert.doesNotMatch(r.stdout, /Cross-carrier remediation closure asserted for/);
    assert.doesNotMatch(r.stdout, /Named-definition corpus-grep evidence asserted for/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // the same folder with a proposal carrier fails (j) closed before dispatch
  const withProposal = liteFixture({
    extra: (active) => writeFileSync(path.join(active, "proposal.md"), PROPOSAL_BASE),
  });
  try {
    const r = runGate(withProposal, ["--pre-review"], LITE_BRANCH_ENV);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}\n${r.stdout}`);
    assert.match(r.stderr, new RegExp(ACTIVE));
    assert.match(r.stderr, /lite-scope-with-proposal/);
  } finally {
    rmSync(withProposal, { recursive: true, force: true });
  }
});

test("the lite scope record is gitignored through the managed baseline and this repo's own block", () => {
  const pattern = "openspec/changes/**/lite-scope.md";
  const repoRoot = path.resolve(HERE, "../../..");
  const baseline = readFileSync(path.join(repoRoot, ".devpro/agent-rules/gitignore-alignment.md"), "utf8")
    .split("<!-- devpro-gitignore-baseline begin -->")[1]?.split("<!-- devpro-gitignore-baseline end -->")[0];
  assert.ok(baseline, "gitignore-alignment.md must carry the baseline marker block");
  assert.ok(baseline.split("\n").includes(pattern), `${pattern} must be a baseline entry`);
  const managed = readFileSync(path.join(repoRoot, ".gitignore"), "utf8")
    .split("# devpro-agent-rules managed begin")[1]?.split("# devpro-agent-rules managed end")[0];
  assert.ok(managed, ".gitignore must carry the managed block");
  assert.ok(managed.split("\n").includes(pattern), `${pattern} must be in this repo's managed block`);
  for (const candidate of [
    "openspec/changes/x/lite-scope.md",
    "openspec/changes/archive/2026-01-01-x/lite-scope.md",
  ]) {
    const probe = spawnSync("git", ["check-ignore", "-q", "--no-index", "--", candidate], { cwd: repoRoot });
    assert.equal(probe.status, 0, `${candidate} must be gitignored`);
  }
  const sibling = spawnSync("git", ["check-ignore", "-q", "--no-index", "--", "openspec/changes/x/proposal.md"], { cwd: repoRoot });
  assert.equal(sibling.status, 1, "the pattern must not swallow the proposal carrier");
});

// #2968: actual dispatch gate must catch a committed test omitted from Touch.
test("--pre-review blocks a changed test missing from proposal Touch", () => {
  const dir = fixture({ attestationIn: "active" });
  try {
    writeFileSync(path.join(dir, "missing-acceptance.test.mjs"), "// fixture\n");
    git(dir, ["add", "missing-acceptance.test.mjs"]);
    git(dir, ["commit", "-m", "add omitted acceptance test"]);
    const r = runGate(dir, ["--pre-review"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /lint-proposal-touch-coverage/);
    assert.match(r.stderr, /missing-acceptance\.test\.mjs/);
    assert.doesNotMatch(r.stdout, /regression-head currency asserted/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("--pre-review Touch uses explicit PR baseline rather than immutable change base", () => {
  const dir = fixture({ attestationIn: "active" });
  try {
    writeFileSync(path.join(dir, "inherited-target.mjs"), "// fixture\n");
    git(dir, ["add", "inherited-target.mjs"]);
    git(dir, ["commit", "-m", "inherited target change"]);
    git(dir, ["update-ref", "refs/remotes/origin/release", "HEAD"]);
    const r = runGate(dir, ["--pre-review", "--baseline-ref", "origin/release"]);
    assert.equal(r.status, 1); // old QA receipt must still block later in the gate
    assert.match(r.stdout, /proposal-touch-coverage/);
    assert.match(r.stderr, /has not been recorded green at the current HEAD/);
    assert.doesNotMatch(r.stderr, /changed file missing from Touch/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("--pre-review explicitly reports proven-lite Touch coverage N/A", () => {
  const dir = liteFixture();
  try {
    const r = runGate(dir, ["--pre-review"], LITE_BRANCH_ENV);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Touch coverage N\/A \(lite has no proposal\)/);
    assert.doesNotMatch(r.stdout, /^.*Active content lints asserted.*$/m);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("--pre-review requires each owned Touch table without union coverage", () => {
  const dir = fixture({ attestationIn: "active", identity: "consumer", regressionHead: "missing", boundedCarriers: false });
  try {
    const second = "pre-review-change-two";
    const firstDir = path.join(dir, "openspec/changes", ACTIVE);
    const secondDir = path.join(dir, "openspec/changes", second);
    mkdirSync(secondDir, { recursive: true });
    for (const carrier of ["brd.md", "tasks.md", "decisions.md"]) {
      writeFileSync(path.join(secondDir, carrier), readFileSync(path.join(firstDir, carrier)));
    }
    const rows = names => names.map(name => `| \`${name}\` | code | edit | R1 |\n`).join("");
    const complete = PROPOSAL_BASE.replace("## Section 3: Tasks", rows(["alpha.test.mjs", "beta.test.mjs"]) + "\n## Section 3: Tasks");
    const partial = PROPOSAL_BASE.replace("## Section 3: Tasks", rows(["beta.test.mjs"]) + "\n## Section 3: Tasks");
    writeFileSync(path.join(firstDir, "proposal.md"), complete);
    writeFileSync(path.join(secondDir, "proposal.md"), partial);
    for (const name of ["alpha.test.mjs", "beta.test.mjs"]) writeFileSync(path.join(dir, name), "// fixture\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-qm", "two owned changes with incomplete second table"]);
    const env = { DEVPRO_DIFF_ACTIVE_CHANGES: `${ACTIVE},${second}` };
    const blocked = runGate(dir, ["--pre-review"], env);
    assert.equal(blocked.status, 1, blocked.stderr + blocked.stdout);
    assert.match(blocked.stderr, /lint-proposal-touch-coverage/);
    assert.match(blocked.stderr, new RegExp(second));
    assert.match(blocked.stderr, /alpha\.test\.mjs/);
    // Same complete PR diff, now covered by each table independently.
    writeFileSync(path.join(secondDir, "proposal.md"), complete);
    git(dir, ["add", "."]);
    git(dir, ["commit", "-qm", "complete second table"]);
    const passed = runGate(dir, ["--pre-review"], env);
    assert.equal(passed.status, 0, passed.stderr + passed.stdout);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
