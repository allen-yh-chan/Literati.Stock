import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT, repoPath, SOURCE_ROOT } from "./lib/repo-root.mjs";
import { readRepoFile as read } from "./lib/read.mjs";

const changeName = "strengthen-diagnosis-go-reentry";
const prewriteGateChangeName = "strengthen-diagnosis-reentry-prewrite-gate";


function readFirst(relPaths) {
  for (const relPath of relPaths) {
    const fullPath = repoPath(relPath);
    if (existsSync(fullPath)) return readFileSync(fullPath, "utf8");
  }
  throw new Error(`none of the candidate files exist: ${relPaths.join(", ")}`);
}

function readProposalMini(candidateChangeName = changeName) {
  const activePath = path.join(SOURCE_ROOT, "openspec/changes", candidateChangeName, "proposal-mini.md");
  if (existsSync(activePath)) return readFileSync(activePath, "utf8");

  const archiveRoot = repoPath("openspec/changes/archive");
  const archivedDir = existsSync(archiveRoot)
    ? readdirSync(archiveRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.endsWith(`-${candidateChangeName}`))
      .map((entry) => entry.name)
      .sort()
      .at(-1)
    : undefined;

  assert.ok(archivedDir, `missing active or archived proposal-mini for ${candidateChangeName}`);
  return readFileSync(path.join(archiveRoot, archivedDir, "proposal-mini.md"), "utf8");
}

function assertIncludes(content, tokens, label) {
  for (const token of tokens) {
    assert.ok(content.includes(token), `${label} missing ${token}`);
  }
}

const ruleLeaf = read(".devpro/agent-rules/openspec-flow.md");
const dpChangeSkill = read(".devpro/agent-skills/devpro-workflows/change/SKILL.md");
const specCarrier = readFirst([
  `openspec/changes/${changeName}/specs/openspec-flow/spec.md`,
  "openspec/specs/openspec-flow/spec.md",
]);
const prewriteGateSpecCarrier = readFirst([
  `openspec/changes/${prewriteGateChangeName}/specs/openspec-flow/spec.md`,
  "openspec/specs/openspec-flow/spec.md",
]);
const proposalMini = readProposalMini();
const prewriteGateProposalMini = readProposalMini(prewriteGateChangeName);

const reentryAnchors = [
  "Diagnosis-to-implementation re-entry",
  "diagnosis",
  "timing",
  "read-only",
  "just look",
  "`go`",
  "`開始修`",
  "`實作`",
  "`do it`",
  "/devpro:change",
  "before any repo write",
  "active intent",
];

const prewriteGateAnchors = [
  "notes/session-pending.md",
  "batch approval",
  "pre-write evidence checkpoint",
  "Batch Approval Ledger",
  "N/A: no batch approval selected",
  "OpenSpec repo write",
];

test("rule leaf and devpro:change skill preserve diagnosis-to-go re-entry anchors", () => {
  for (const [label, content] of [
    [".devpro/agent-rules/openspec-flow.md", ruleLeaf],
    [".devpro/agent-skills/devpro-workflows/change/SKILL.md", dpChangeSkill],
  ]) {
    assertIncludes(content, reentryAnchors, label);
    assertIncludes(content, ["completed change startup"], label);
    assertIncludes(content, prewriteGateAnchors, label);
  }

  assertIncludes(
    ruleLeaf,
    ["Mandatory Clause Enforcement Map", "diagnosis-to-implementation re-entry", "diagnosis-go-reentry-grep.test.mjs", "pre-tool-gate.mjs", "Gate SP"],
    ".devpro/agent-rules/openspec-flow.md enforcement map",
  );
});

test("openspec-flow spec carrier preserves active-intent and startup-boundary semantics", () => {
  assertIncludes(
    specCarrier,
    [
      "Diagnosis-To-Implementation Re-Entry",
      "diagnosis",
      "timing",
      "read-only",
      "just look",
      "`go`",
      "`開始修`",
      "`實作`",
      "`do it`",
      "/devpro:change",
      "before any repo write",
      "active implementation intent",
      "completed change startup",
    ],
    "openspec-flow spec carrier",
  );
});

test("current proposal-mini and spec preserve session-pending pre-write checkpoint evidence", () => {
  assertIncludes(
    prewriteGateProposalMini,
    [
      "strengthen-diagnosis-reentry-prewrite-gate",
      "same-change-dp-change-batch",
      "pr_merge",
      "release",
      "destructive",
      "secrets",
      "cross_repo_write",
      "Rule-feedback Surface Matrix",
      "Session-pending source",
      "design second-review: N/A - no design.md",
    ],
    "strengthen-diagnosis-reentry-prewrite-gate proposal-mini.md",
  );

  assertIncludes(
    prewriteGateSpecCarrier,
    [
      "Claimed Session-Pending Batch Approval Blocks N/A Ledger Before Implementation Write",
      "Re-Entry Evidence Checkpoint Precedes First Implementation Write",
      "notes/session-pending.md",
      "Batch Approval Ledger",
      "N/A: no batch approval selected",
      "non-OpenSpec repo write",
    ],
    "strengthen-diagnosis-reentry-prewrite-gate openspec-flow delta",
  );
  assert.doesNotMatch(
    prewriteGateSpecCarrier,
    /approval-boundary evidence/,
    "Gate SP spec must not widen beyond batch approval evidence unless hook detection is expanded",
  );
});

test("proposal-mini preserves issue-backed rule-feedback evidence", () => {
  assertIncludes(
    proposalMini,
    [
      "issue: #1650",
      "Diagnosis-to-implementation re-entry",
      "diagnosis",
      "timing",
      "read-only",
      "just look",
      "`go`",
      "`開始修`",
      "`實作`",
      "`do it`",
      // legacy-skill-names:begin diagnosis-go-reentry-archived-proposal-mini
      "/dp-change", // archived openspec/changes/archive/2026-07-14-strengthen-diagnosis-go-reentry/proposal-mini.md is never rewritten
      // legacy-skill-names:end diagnosis-go-reentry-archived-proposal-mini
      "before any repo write",
      "implementation intent",
      "## Rule-feedback Surface Matrix",
      "## Requirement Ledger",
      "R1",
      "R2",
      "main@990aef84",
    ],
    "proposal-mini.md",
  );
});

test("devpro:change skill change entry gate covers rule-feedback implementation requests", () => {
  const gateLine = dpChangeSkill
    .split(/\r?\n/)
    .find((line) => line.includes("Change Entry Gate"));

  assert.ok(gateLine, ".devpro/agent-skills/devpro-workflows/change/SKILL.md missing Change Entry Gate line");
  assert.match(
    gateLine,
    /Change Entry Gate.*future AI behavior.*調整 rule、workflow、process.*TL MUST route through devpro:change\/OpenSpec before any non-OpenSpec repo write.*明確 no-op.*exemption evidence.*才可跳過/,
    ".devpro/agent-skills/devpro-workflows/change/SKILL.md must bind rule-feedback implementation requests to devpro:change/OpenSpec before write with exemption evidence",
  );
  assert.doesNotMatch(
    gateLine,
    /MUST NOT route through devpro:change\/OpenSpec|MAY route through devpro:change\/OpenSpec|SHOULD route through devpro:change\/OpenSpec/,
    ".devpro/agent-skills/devpro-workflows/change/SKILL.md must not weaken the Change Entry Gate modality",
  );
});
