/**
 * batch-approval-ledger.test.mjs
 *
 * Unit tests for the pure-function `## Batch Approval Ledger` read/judgment
 * module shared by pre-write gates (identity strength) and the archive
 * check (c) extension (shape strength):
 * `.devpro/scripts/lib/batch-approval-ledger.mjs`.
 *
 * See openspec/changes/enforce-batch-scope-ledger-presence/design.md D2/D3.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { makeTempDir } from "./lib/tmp.mjs";
import {
  extractH2Section,
  evaluateBatchApprovalLedgerIdentity,
  evaluateBatchApprovalLedgerShape,
  evaluateBatchApprovalLedgerForSessionPendingPrewrite,
  evaluateBatchApprovalLedgerForGeneralModePrewrite,
  evaluateLiteScopeRecord,
  LEGACY_DISCLOSURE_LEDGER_TOKENS,
  readLiteScopeRecord,
} from "../lib/batch-approval-ledger.mjs";

const CHANGE_NAME = "enforce-batch-scope-ledger-presence";
const BRANCH = "chore/enforce-batch-scope-ledger-presence";

function proposalWith(ledgerBody) {
  return [
    "## Why",
    "",
    "Some rationale.",
    "",
    "## Batch Approval Ledger",
    "",
    ledgerBody,
    "",
    "## What Changes",
    "",
    "Some change.",
    "",
  ].join("\n");
}

const NA_LEDGER = "N/A: no batch approval selected";

const STRUCTURED_LEDGER = [
  "kind: same-change-dp-change-batch",
  `named_change: ${CHANGE_NAME}`,
  `branch: ${BRANCH}`,
  "repo_scope: same-repo",
  "covers:",
  "  - openspec/changes/enforce-batch-scope-ledger-presence/",
  "excludes:",
  "  - unrelated/path/",
].join("\n");

// ---------------------------------------------------------------------------
// extractH2Section (moved in from pre-tool-gate.mjs)
// ---------------------------------------------------------------------------

test("extractH2Section: returns the body between the named H2 and the next H2", () => {
  const content = proposalWith(STRUCTURED_LEDGER);
  const section = extractH2Section(content, "Batch Approval Ledger");
  assert.match(section, /kind: same-change-dp-change-batch/);
  assert.doesNotMatch(section, /## What Changes/);
});

test("extractH2Section: returns empty string when heading absent", () => {
  const content = "## Why\n\nSome rationale.\n";
  assert.equal(extractH2Section(content, "Batch Approval Ledger"), "");
});

// ---------------------------------------------------------------------------
// evaluateBatchApprovalLedgerIdentity
// ---------------------------------------------------------------------------

test("identity: missing `## Batch Approval Ledger` heading -> issue set, isNA false", () => {
  const content = "## Why\n\nSome rationale.\n";
  const result = evaluateBatchApprovalLedgerIdentity(content, {
    changeName: CHANGE_NAME,
    branch: BRANCH,
  });
  assert.equal(result.issue, "is missing `## Batch Approval Ledger`");
  assert.equal(result.isNA, false);
});

test("identity: N/A sentinel -> issue set, isNA true", () => {
  const content = proposalWith(NA_LEDGER);
  const result = evaluateBatchApprovalLedgerIdentity(content, {
    changeName: CHANGE_NAME,
    branch: BRANCH,
  });
  assert.equal(result.issue, "still says `N/A: no batch approval selected`");
  assert.equal(result.isNA, true);
});

test("identity: fully valid structured ledger -> no issue, isNA false", () => {
  const content = proposalWith(STRUCTURED_LEDGER);
  const result = evaluateBatchApprovalLedgerIdentity(content, {
    changeName: CHANGE_NAME,
    branch: BRANCH,
  });
  assert.equal(result.issue, "");
  assert.equal(result.isNA, false);
});

test("identity: mismatched `kind` -> missing or mismatched issue", () => {
  const ledger = STRUCTURED_LEDGER.replace(
    "kind: same-change-dp-change-batch",
    "kind: cross-repo-dp-change-batch",
  );
  const result = evaluateBatchApprovalLedgerIdentity(proposalWith(ledger), {
    changeName: CHANGE_NAME,
    branch: BRANCH,
  });
  assert.equal(result.issue, "has missing or mismatched `kind`");
  assert.equal(result.isNA, false);
});

test("identity: mismatched `named_change` (different change) -> missing or mismatched issue", () => {
  const ledger = STRUCTURED_LEDGER.replace(
    `named_change: ${CHANGE_NAME}`,
    "named_change: some-other-change",
  );
  const result = evaluateBatchApprovalLedgerIdentity(proposalWith(ledger), {
    changeName: CHANGE_NAME,
    branch: BRANCH,
  });
  assert.equal(result.issue, "has missing or mismatched `named_change`");
});

test("identity: mismatched `branch` -> missing or mismatched issue", () => {
  const ledger = STRUCTURED_LEDGER.replace(`branch: ${BRANCH}`, "branch: chore/some-other-branch");
  const result = evaluateBatchApprovalLedgerIdentity(proposalWith(ledger), {
    changeName: CHANGE_NAME,
    branch: BRANCH,
  });
  assert.equal(result.issue, "has missing or mismatched `branch`");
});

test("identity: mismatched `repo_scope` -> missing or mismatched issue", () => {
  const ledger = STRUCTURED_LEDGER.replace("repo_scope: same-repo", "repo_scope: cross-repo");
  const result = evaluateBatchApprovalLedgerIdentity(proposalWith(ledger), {
    changeName: CHANGE_NAME,
    branch: BRANCH,
  });
  assert.equal(result.issue, "has missing or mismatched `repo_scope`");
});

test("identity: empty `covers` -> empty covers issue", () => {
  const ledger = STRUCTURED_LEDGER.replace(
    "covers:\n  - openspec/changes/enforce-batch-scope-ledger-presence/",
    "covers:",
  );
  const result = evaluateBatchApprovalLedgerIdentity(proposalWith(ledger), {
    changeName: CHANGE_NAME,
    branch: BRANCH,
  });
  assert.equal(result.issue, "has empty or missing `covers`");
});

test("identity: empty `excludes` -> empty excludes issue", () => {
  const ledger = STRUCTURED_LEDGER.replace(
    "excludes:\n  - unrelated/path/",
    "excludes:",
  );
  const result = evaluateBatchApprovalLedgerIdentity(proposalWith(ledger), {
    changeName: CHANGE_NAME,
    branch: BRANCH,
  });
  assert.equal(result.issue, "has empty or missing `excludes`");
});

// ---------------------------------------------------------------------------
// evaluateBatchApprovalLedgerShape
// ---------------------------------------------------------------------------

const ARCHIVE_NAME_WITH_DATE = `2026-08-22-${CHANGE_NAME}`;

test("shape: missing heading -> absent", () => {
  const content = "## Why\n\nSome rationale.\n";
  assert.equal(
    evaluateBatchApprovalLedgerShape(content, { archiveName: ARCHIVE_NAME_WITH_DATE }),
    "absent",
  );
});

test("shape: N/A sentinel -> ok", () => {
  const content = proposalWith(NA_LEDGER);
  assert.equal(
    evaluateBatchApprovalLedgerShape(content, { archiveName: ARCHIVE_NAME_WITH_DATE }),
    "ok",
  );
});

test("full revocation replaces all authority while preserving R1/archive and SP polarity", () => {
  const options = { changeName: CHANGE_NAME, branch: BRANCH };
  const active = proposalWith(STRUCTURED_LEDGER);
  assert.deepEqual(evaluateBatchApprovalLedgerIdentity(active, options), { issue: "", isNA: false });
  const revoked = active.replace(STRUCTURED_LEDGER, NA_LEDGER);
  assert.ok(!revoked.includes("kind: same-change-dp-change-batch"));
  assert.equal(evaluateBatchApprovalLedgerIdentity(revoked, options).isNA, true);
  assert.equal(evaluateBatchApprovalLedgerForGeneralModePrewrite(revoked, options), "");
  assert.equal(evaluateBatchApprovalLedgerShape(revoked, { archiveName: ARCHIVE_NAME_WITH_DATE }), "ok");
  assert.notEqual(evaluateBatchApprovalLedgerForSessionPendingPrewrite(revoked, options), "");
  const appended = proposalWith(`${STRUCTURED_LEDGER}\n${NA_LEDGER}`);
  assert.equal(evaluateBatchApprovalLedgerIdentity(appended, options).isNA, false, "appending N/A cannot revoke a populated ledger");
});

test("shape: fully structured ledger, archiveName carries YYYY-MM-DD- prefix -> ok (date-prefix regression case)", () => {
  const content = proposalWith(STRUCTURED_LEDGER);
  assert.equal(
    evaluateBatchApprovalLedgerShape(content, { archiveName: ARCHIVE_NAME_WITH_DATE }),
    "ok",
  );
});

test("shape: archiveName without a date prefix falls back to literal comparison and still resolves ok", () => {
  const ledger = STRUCTURED_LEDGER.replace(
    `named_change: ${CHANGE_NAME}`,
    `named_change: ${CHANGE_NAME}-no-date-prefix`,
  );
  const content = proposalWith(ledger);
  assert.equal(
    evaluateBatchApprovalLedgerShape(content, {
      archiveName: `${CHANGE_NAME}-no-date-prefix`,
    }),
    "ok",
  );
});

test("shape: empty shell with only `kind:` line -> shapeless (round-1 CRITICAL finding regression case)", () => {
  const content = proposalWith("kind: same-change-dp-change-batch");
  assert.equal(
    evaluateBatchApprovalLedgerShape(content, { archiveName: ARCHIVE_NAME_WITH_DATE }),
    "shapeless",
  );
});

test("shape: missing `kind` -> shapeless", () => {
  const ledger = STRUCTURED_LEDGER.split("\n")
    .filter((line) => !line.startsWith("kind:"))
    .join("\n");
  assert.equal(
    evaluateBatchApprovalLedgerShape(proposalWith(ledger), { archiveName: ARCHIVE_NAME_WITH_DATE }),
    "shapeless",
  );
});

test("shape: missing `repo_scope` -> shapeless", () => {
  const ledger = STRUCTURED_LEDGER.split("\n")
    .filter((line) => !line.startsWith("repo_scope:"))
    .join("\n");
  assert.equal(
    evaluateBatchApprovalLedgerShape(proposalWith(ledger), { archiveName: ARCHIVE_NAME_WITH_DATE }),
    "shapeless",
  );
});

test("shape: empty `covers` -> shapeless", () => {
  const ledger = STRUCTURED_LEDGER.replace(
    "covers:\n  - openspec/changes/enforce-batch-scope-ledger-presence/",
    "covers:",
  );
  assert.equal(
    evaluateBatchApprovalLedgerShape(proposalWith(ledger), { archiveName: ARCHIVE_NAME_WITH_DATE }),
    "shapeless",
  );
});

// dp-reviewer round-3 finding I-1: `covers`/`excludes` as a one-line YAML
// flow sequence (`covers: [a, b]`) is semantically identical to the
// multi-line block-style form and appears in 7 real historical archives —
// Gate R1 fires on every implementation write, so misjudging this
// template-legal shape as "empty" is a live false-block, not a cosmetic gap.
test("identity: flow-style `covers`/`excludes` (`covers: [a, b]`) -> no issue", () => {
  const ledger = STRUCTURED_LEDGER
    .replace("covers:\n  - openspec/changes/enforce-batch-scope-ledger-presence/", "covers: [openspec_authoring, local_commit]")
    .replace("excludes:\n  - unrelated/path/", "excludes: [merge, release]");
  assert.deepEqual(
    evaluateBatchApprovalLedgerIdentity(proposalWith(ledger), { changeName: CHANGE_NAME, branch: BRANCH }),
    { issue: "", isNA: false },
  );
});

test("shape: flow-style `covers`/`excludes` -> ok", () => {
  const ledger = STRUCTURED_LEDGER
    .replace("covers:\n  - openspec/changes/enforce-batch-scope-ledger-presence/", "covers: [openspec_authoring, local_commit]")
    .replace("excludes:\n  - unrelated/path/", "excludes: [merge, release]");
  assert.equal(
    evaluateBatchApprovalLedgerShape(proposalWith(ledger), { archiveName: ARCHIVE_NAME_WITH_DATE }),
    "ok",
  );
});

test("identity: flow-style `covers: []` (empty flow sequence) -> still has empty or missing `covers`", () => {
  const ledger = STRUCTURED_LEDGER.replace(
    "covers:\n  - openspec/changes/enforce-batch-scope-ledger-presence/",
    "covers: []",
  );
  assert.equal(
    evaluateBatchApprovalLedgerIdentity(proposalWith(ledger), { changeName: CHANGE_NAME, branch: BRANCH }).issue,
    "has empty or missing `covers`",
  );
});

test("shape: missing `excludes` key entirely -> shapeless", () => {
  const ledger = STRUCTURED_LEDGER.split("\n")
    .filter((line) => line !== "excludes:" && line !== "  - unrelated/path/")
    .join("\n");
  assert.equal(
    evaluateBatchApprovalLedgerShape(proposalWith(ledger), { archiveName: ARCHIVE_NAME_WITH_DATE }),
    "shapeless",
  );
});

test("shape: present but empty `excludes` key -> ok (key presence only, non-empty not required)", () => {
  const ledger = STRUCTURED_LEDGER.replace(
    "excludes:\n  - unrelated/path/",
    "excludes:",
  );
  assert.equal(
    evaluateBatchApprovalLedgerShape(proposalWith(ledger), { archiveName: ARCHIVE_NAME_WITH_DATE }),
    "ok",
  );
});

test("shape: empty `branch` -> shapeless", () => {
  const ledger = STRUCTURED_LEDGER.replace(`branch: ${BRANCH}`, "branch:");
  assert.equal(
    evaluateBatchApprovalLedgerShape(proposalWith(ledger), { archiveName: ARCHIVE_NAME_WITH_DATE }),
    "shapeless",
  );
});

test("shape: `branch` present and non-empty but not the current branch -> still ok (content not compared)", () => {
  const ledger = STRUCTURED_LEDGER.replace(`branch: ${BRANCH}`, "branch: chore/some-other-branch");
  assert.equal(
    evaluateBatchApprovalLedgerShape(proposalWith(ledger), { archiveName: ARCHIVE_NAME_WITH_DATE }),
    "ok",
  );
});

test("shape: `named_change` mismatched against archiveName's bare (date-stripped) name -> shapeless", () => {
  const ledger = STRUCTURED_LEDGER.replace(
    `named_change: ${CHANGE_NAME}`,
    "named_change: some-other-change",
  );
  assert.equal(
    evaluateBatchApprovalLedgerShape(proposalWith(ledger), { archiveName: ARCHIVE_NAME_WITH_DATE }),
    "shapeless",
  );
});

// dp-reviewer I1 regression: the N/A sentinel must anchor to the section's
// first non-blank line, not merely appear anywhere in the section text —
// otherwise a stray mention (e.g. a comment warning against writing it)
// would launder an incomplete ledger into `ok`/N/A, the same class of
// bypass as round-1 F-1-1 (see decisions.md).

test("identity: fully valid structured ledger that also mentions the N/A sentinel in trailing prose -> still no issue, NOT downgraded to isNA", () => {
  const ledger = STRUCTURED_LEDGER + "\n# reminder: do not write N/A: no batch approval selected here";
  const result = evaluateBatchApprovalLedgerIdentity(proposalWith(ledger), {
    changeName: CHANGE_NAME,
    branch: BRANCH,
  });
  assert.equal(result.issue, "");
  assert.equal(result.isNA, false);
});

test("identity: empty-shell ledger (only `kind:` line) that also mentions the N/A sentinel in trailing prose -> still a mismatch issue, NOT laundered into isNA/pass", () => {
  const ledger = "kind: same-change-dp-change-batch\n# note: N/A: no batch approval selected is not what we chose";
  const result = evaluateBatchApprovalLedgerIdentity(proposalWith(ledger), {
    changeName: CHANGE_NAME,
    branch: BRANCH,
  });
  assert.notEqual(result.issue, "");
  assert.equal(result.isNA, false);
});

test("shape: fully structured ledger that also mentions the N/A sentinel in trailing prose -> still ok via structural fields, NOT via the sentinel", () => {
  const ledger = STRUCTURED_LEDGER + "\n# reminder: do not write N/A: no batch approval selected here";
  assert.equal(
    evaluateBatchApprovalLedgerShape(proposalWith(ledger), { archiveName: ARCHIVE_NAME_WITH_DATE }),
    "ok",
  );
});

test("shape: empty-shell ledger (only `kind:` line) that also mentions the N/A sentinel in trailing prose -> still shapeless, NOT laundered into ok", () => {
  const ledger = "kind: same-change-dp-change-batch\n# note: N/A: no batch approval selected is not what we chose";
  assert.equal(
    evaluateBatchApprovalLedgerShape(proposalWith(ledger), { archiveName: ARCHIVE_NAME_WITH_DATE }),
    "shapeless",
  );
});

// dp-reviewer S1 regression: mode-locked wrappers make each pre-write gate's
// N/A polarity part of the function signature, so a caller cannot silently
// inherit the wrong gate's polarity by reading only `.issue` off the raw
// identity result.

test("evaluateBatchApprovalLedgerForSessionPendingPrewrite: N/A sentinel -> non-empty issue (Gate SP blocks on N/A)", () => {
  const issue = evaluateBatchApprovalLedgerForSessionPendingPrewrite(proposalWith(NA_LEDGER), {
    changeName: CHANGE_NAME,
    branch: BRANCH,
  });
  assert.notEqual(issue, "");
});

test("evaluateBatchApprovalLedgerForSessionPendingPrewrite: fully valid structured ledger -> empty issue", () => {
  const issue = evaluateBatchApprovalLedgerForSessionPendingPrewrite(proposalWith(STRUCTURED_LEDGER), {
    changeName: CHANGE_NAME,
    branch: BRANCH,
  });
  assert.equal(issue, "");
});

test("evaluateBatchApprovalLedgerForGeneralModePrewrite: N/A sentinel -> empty issue (general mode passes on N/A)", () => {
  const issue = evaluateBatchApprovalLedgerForGeneralModePrewrite(proposalWith(NA_LEDGER), {
    changeName: CHANGE_NAME,
    branch: BRANCH,
  });
  assert.equal(issue, "");
});

test("evaluateBatchApprovalLedgerForGeneralModePrewrite: missing heading -> non-empty issue", () => {
  const content = ["## Why", "", "Some rationale.", "", "## What Changes", "", "Some change.", ""].join("\n");
  const issue = evaluateBatchApprovalLedgerForGeneralModePrewrite(content, {
    changeName: CHANGE_NAME,
    branch: BRANCH,
  });
  assert.notEqual(issue, "");
});

// ---------------------------------------------------------------------------
// CRLF line-ending regression (PR #2279 cross-model dispute)
//
// GPT-5 second-opinion review of PR #2279 raised a CRITICAL finding that
// extractH2Section's `^`/`$` heading/section-boundary regexes could fail on
// a CRLF-checked-out proposal.md (Windows checkout / autocrlf), silently
// yielding an empty section and defeating the ledger check. Ad hoc
// experimentation against these real functions with `\r\n`-joined fixtures
// showed this doesn't reproduce: JS regex `^`/`$` in `m` mode treat a bare
// `\r` itself as a line terminator (ECMA-262), so these patterns are already
// CRLF-tolerant. These tests pin that property so a future regex change
// cannot silently regress it.
// ---------------------------------------------------------------------------

function toCRLF(content) {
  return content.replace(/\n/g, "\r\n");
}

test("extractH2Section: CRLF content -> still extracts the section body", () => {
  const content = toCRLF(proposalWith(STRUCTURED_LEDGER));
  const section = extractH2Section(content, "Batch Approval Ledger");
  assert.match(section, /kind: same-change-dp-change-batch/);
  assert.doesNotMatch(section, /## What Changes/);
});

test("identity: CRLF content, fully valid structured ledger -> no issue, isNA false", () => {
  const content = toCRLF(proposalWith(STRUCTURED_LEDGER));
  const result = evaluateBatchApprovalLedgerIdentity(content, {
    changeName: CHANGE_NAME,
    branch: BRANCH,
  });
  assert.equal(result.issue, "");
  assert.equal(result.isNA, false);
});

test("identity: CRLF content, N/A sentinel -> issue set, isNA true", () => {
  const content = toCRLF(proposalWith(NA_LEDGER));
  const result = evaluateBatchApprovalLedgerIdentity(content, {
    changeName: CHANGE_NAME,
    branch: BRANCH,
  });
  assert.equal(result.issue, "still says `N/A: no batch approval selected`");
  assert.equal(result.isNA, true);
});

test("shape: CRLF content, fully structured ledger -> ok", () => {
  const content = toCRLF(proposalWith(STRUCTURED_LEDGER));
  assert.equal(
    evaluateBatchApprovalLedgerShape(content, { archiveName: ARCHIVE_NAME_WITH_DATE }),
    "ok",
  );
});

test("shape: CRLF content, N/A sentinel -> ok", () => {
  const content = toCRLF(proposalWith(NA_LEDGER));
  assert.equal(
    evaluateBatchApprovalLedgerShape(content, { archiveName: ARCHIVE_NAME_WITH_DATE }),
    "ok",
  );
});

test("evaluateBatchApprovalLedgerForGeneralModePrewrite: CRLF content, structured ledger -> empty issue", () => {
  const issue = evaluateBatchApprovalLedgerForGeneralModePrewrite(toCRLF(proposalWith(STRUCTURED_LEDGER)), {
    changeName: CHANGE_NAME,
    branch: BRANCH,
  });
  assert.equal(issue, "");
});

test("evaluateBatchApprovalLedgerForGeneralModePrewrite: CRLF content, N/A sentinel -> empty issue", () => {
  const issue = evaluateBatchApprovalLedgerForGeneralModePrewrite(toCRLF(proposalWith(NA_LEDGER)), {
    changeName: CHANGE_NAME,
    branch: BRANCH,
  });
  assert.equal(issue, "");
});

// ---------------------------------------------------------------------------
// Retired ledger items (remove-second-review-disclosure-framework design.md D4)
// and the lite scope record.
// ---------------------------------------------------------------------------

const LEGACY_TOKENS = [
  "same_repo_exact_pr_external_disclosure",
  "reviewer_sticky_write_back",
  "reviewer_owned_sticky_write_back",
  "external_disclosure",
];

// Both lists keep at least one legal item so that, after the legacy item is
// removed as the diagnostic instructs, the ledger is rejected for no other reason.
const LEGAL_COVERS = ["worktree", "local_commit", "first_push"];
const LEGAL_EXCLUDES = ["merge", "release"];

function renderList(key, items, style) {
  if (style === "flow") return [`${key}: [${items.join(", ")}]`];
  return [`${key}:`, ...items.map((item) => `  - ${item}`)];
}

function ledgerBody({ covers = LEGAL_COVERS, excludes = LEGAL_EXCLUDES, style = "block", coversStyle = style, excludesStyle = style } = {}) {
  return [
    "kind: same-change-dp-change-batch",
    `named_change: ${CHANGE_NAME}`,
    `branch: ${BRANCH}`,
    "repo_scope: same-repo",
    ...renderList("covers", covers, coversStyle),
    ...renderList("excludes", excludes, excludesStyle),
  ].join("\n");
}

function identityIssue(body) {
  return evaluateBatchApprovalLedgerIdentity(proposalWith(body), { changeName: CHANGE_NAME, branch: BRANCH }).issue;
}

function shapeVerdict(body) {
  return evaluateBatchApprovalLedgerShape(proposalWith(body), { archiveName: ARCHIVE_NAME_WITH_DATE });
}

// Tokens named by a legacy diagnostic: the single backtick span right after
// `item(s)`, entries joined by `, ` (design.md D3).
function namedTokens(issue) {
  const match = /^has retired ledger item\(s\) `([^`]+)` in `covers`\/`excludes`:/.exec(issue);
  assert.ok(match, `issue must be the retired-item diagnostic, got: ${issue}`);
  return match[1].split(", ");
}

// Apply the removal the diagnostic describes, mechanically and only to what it
// names: block list -> delete just those `- <item>` lines; flow list -> delete
// just those names inside the brackets (never the whole key line).
function removeNamedItems(body, names) {
  return body.split("\n").flatMap((line) => {
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

// Items of one `covers`/`excludes` list in flow or block style, exactly as written (the removal must keep the rest).
function ledgerItems(text, key) {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line.startsWith(`${key}:`));
  const flow = /^[a-z]+:[\t ]*\[([^\]]*)\][\t ]*$/.exec(lines[at]);
  if (flow) return flow[1].split(",").map((entry) => entry.trim()).filter(Boolean);
  const items = [];
  for (const line of lines.slice(at + 1)) {
    const block = /^[\t ]+-[\t ]+(\S.*?)[\t ]*$/.exec(line);
    if (!block) break;
    items.push(block[1]);
  }
  return items;
}

const LEGACY_CASES = [];
for (const token of LEGACY_TOKENS) {
  for (const key of ["covers", "excludes"]) {
    for (const style of ["block", "flow"]) {
      const legalCovers = LEGAL_COVERS;
      const legalExcludes = LEGAL_EXCLUDES;
      const covers = key === "covers" ? [legalCovers[0], token, ...legalCovers.slice(1)] : legalCovers;
      const excludes = key === "excludes" ? [legalExcludes[0], token, ...legalExcludes.slice(1)] : legalExcludes;
      LEGACY_CASES.push({ token, key, style, covers, excludes });
    }
  }
}

test("LEGACY_DISCLOSURE_LEDGER_TOKENS exports exactly the four retired ledger tokens", () => {
  assert.deepEqual([...LEGACY_DISCLOSURE_LEDGER_TOKENS], LEGACY_TOKENS);
});

for (const { token, key, style, covers, excludes } of LEGACY_CASES) {
  const label = `${token} in ${style}-style ${key}`;
  test(`Retired ledger item is rejected with a removal-only fix: ${label} -> identity names it as written, shape returns legacy`, () => {
    const body = ledgerBody({ covers, excludes, style });
    const issue = identityIssue(body);
    assert.deepEqual(namedTokens(issue), [token]);
    assert.match(issue, /remove only those item\(s\) and keep every other item/);
    assert.ok(issue.includes("block list: delete just the `- <item>` lines for them"), issue);
    assert.ok(issue.includes("flow list `[a, b]`: delete just those names inside the brackets, never the whole `covers`/`excludes` line"), issue);
    assert.ok(issue.includes("retired item; delete it"), issue);
    assert.match(issue, /retired/);
    assert.match(issue, /delete/);
    assert.doesNotMatch(issue, /adopt/i);
    assert.ok(!issue.includes("consumer-adoption.md"), issue);
    // The Gate R1 wrapper must surface the same diagnostic.
    assert.equal(evaluateBatchApprovalLedgerForGeneralModePrewrite(proposalWith(body), { changeName: CHANGE_NAME, branch: BRANCH }), issue);
    assert.equal(evaluateBatchApprovalLedgerForSessionPendingPrewrite(proposalWith(body), { changeName: CHANGE_NAME, branch: BRANCH }), issue);
    // Archive gate (c) strength: `legacy` carrying the offending token.
    const verdict = shapeVerdict(body);
    assert.equal(verdict?.verdict, "legacy", `shape must return legacy, got ${JSON.stringify(verdict)}`);
    assert.deepEqual(verdict.tokens, [token]);
  });

  test(`Removing only the named legacy items makes the ledger pass: ${label} -> message-driven removal, validator accepts, every other item kept`, () => {
    const body = ledgerBody({ covers, excludes, style });
    const names = namedTokens(identityIssue(body));
    const fixed = removeNamedItems(body, names);
    assert.notEqual(fixed, body, "the removal must change the ledger");
    assert.equal(identityIssue(fixed), "");
    assert.equal(shapeVerdict(fixed), "ok");
    assert.deepEqual(ledgerItems(fixed, "covers"), LEGAL_COVERS);
    assert.deepEqual(ledgerItems(fixed, "excludes"), LEGAL_EXCLUDES);
    // Flow style: the key line itself survives the removal.
    if (style === "flow") assert.match(fixed, new RegExp(`^${key}: \\[.+\\]$`, "m"));
  });
}

test("Removing only the named legacy items makes the ledger pass: a flow list mixing legal actions with a legacy token loses only that name", () => {
  const body = ledgerBody({
    covers: ["worktree", "reviewer_sticky_write_back", "local_commit"],
    excludes: ["merge", "release", "external_disclosure"],
    style: "flow",
  });
  assert.equal(body.includes("covers: [worktree, reviewer_sticky_write_back, local_commit]"), true);
  const issue = identityIssue(body);
  assert.deepEqual(namedTokens(issue), ["reviewer_sticky_write_back", "external_disclosure"]);
  const fixed = removeNamedItems(body, namedTokens(issue));
  assert.match(fixed, /^covers: \[worktree, local_commit\]$/m);
  assert.match(fixed, /^excludes: \[merge, release\]$/m);
  assert.equal(identityIssue(fixed), "");
  assert.equal(shapeVerdict(fixed), "ok");
});

test("Retired ledger item is rejected with a removal-only fix: block list mixing every legacy token across covers and excludes names all of them as written", () => {
  const body = ledgerBody({
    covers: ["worktree", "Same-Repo-Exact-PR-External-Disclosure", "local_commit", "REVIEWER_STICKY_WRITE_BACK"],
    excludes: ["merge", "Reviewer-Owned-Sticky-Write-Back", "external_disclosure"],
    style: "block",
  });
  const issue = identityIssue(body);
  assert.deepEqual(namedTokens(issue), [
    "Same-Repo-Exact-PR-External-Disclosure",
    "REVIEWER_STICKY_WRITE_BACK",
    "Reviewer-Owned-Sticky-Write-Back",
    "external_disclosure",
  ]);
  const verdict = shapeVerdict(body);
  assert.equal(verdict?.verdict, "legacy");
  assert.deepEqual(verdict.tokens, namedTokens(issue));
  const fixed = removeNamedItems(body, namedTokens(issue));
  assert.equal(identityIssue(fixed), "");
  assert.deepEqual(ledgerItems(fixed, "covers"), ["worktree", "local_commit"]);
  assert.deepEqual(ledgerItems(fixed, "excludes"), ["merge"]);
});

test("Retired ledger item is rejected with a removal-only fix: the diagnostic names the ledger's own spelling, not the normalized token", () => {
  for (const [written, style] of [["Reviewer-Owned-Sticky-Write-Back", "block"], ["Reviewer-Sticky-Write-Back", "flow"], ["EXTERNAL-DISCLOSURE", "block"]]) {
    const body = ledgerBody({ covers: ["worktree", written, "local_commit"], style });
    const issue = identityIssue(body);
    assert.deepEqual(namedTokens(issue), [written]);
    assert.ok(issue.includes(written));
    assert.ok(!issue.includes(written.toLowerCase().replaceAll("-", "_")), `normalized form must not leak into the diagnostic: ${issue}`);
    assert.deepEqual(shapeVerdict(body)?.tokens, [written]);
  }
});

test("Legacy excludes item is reported as an earlier refusal: the diagnostic names only the excludes items and informs without changing the removal-only fix", () => {
  // covers-only legacy item: nothing was refused, so no notice and no excluded tokens.
  const coversOnly = ledgerBody({ covers: [...LEGAL_COVERS, "reviewer_sticky_write_back"] });
  assert.ok(!identityIssue(coversOnly).includes("earlier explicit refusal"), identityIssue(coversOnly));
  assert.deepEqual(shapeVerdict(coversOnly).excluded_tokens, []);

  for (const style of ["block", "flow"]) {
    const body = ledgerBody({
      covers: [...LEGAL_COVERS, "external_disclosure"],
      excludes: [...LEGAL_EXCLUDES, "Reviewer-Sticky-Write-Back"],
      style,
    });
    const issue = identityIssue(body);
    assert.deepEqual(namedTokens(issue), ["external_disclosure", "Reviewer-Sticky-Write-Back"], style);
    // Only the excludes item is called a refusal; the covers item is not.
    assert.ok(issue.includes("`Reviewer-Sticky-Write-Back` was listed under `excludes`, an earlier explicit refusal"), issue);
    assert.ok(!issue.includes("`external_disclosure` was listed under"), issue);
    assert.ok(issue.includes("after removal the second review of this change dispatches like any same-repo PR, so tell the user in the same reply"), issue);
    assert.ok(issue.endsWith("if the refusal should stand, add an ordinary AGENTS.local.md rule that stops before dispatch, or use the waiver path in code-review-cross-model.md §Merge Gate Enforcement."), issue);
    assert.doesNotMatch(issue, /adopt|disclosure notice|overlay/i);
    // It informs; it never turns the fix into a question or a different instruction.
    assert.match(issue, /remove only those item\(s\) and keep every other item/);
    assert.doesNotMatch(issue, /ask the user|confirm with the user/i);
    // Both pre-write gates surface the same text; archive gate (c) gets the excludes subset.
    assert.equal(evaluateBatchApprovalLedgerForGeneralModePrewrite(proposalWith(body), { changeName: CHANGE_NAME, branch: BRANCH }), issue);
    assert.equal(evaluateBatchApprovalLedgerForSessionPendingPrewrite(proposalWith(body), { changeName: CHANGE_NAME, branch: BRANCH }), issue);
    assert.deepEqual(shapeVerdict(body).excluded_tokens, ["Reviewer-Sticky-Write-Back"], style);
    // The removal-only fix is unchanged and still makes the ledger pass.
    const fixed = removeNamedItems(body, namedTokens(issue));
    assert.equal(identityIssue(fixed), "");
    assert.equal(shapeVerdict(fixed), "ok");
  }
});

test("Retired ledger item is rejected with a removal-only fix: a structurally incomplete ledger gets its existing failure first, not legacy", () => {
  const withLegacy = { covers: ["worktree", "external_disclosure"] };
  // Missing heading.
  assert.equal(
    evaluateBatchApprovalLedgerIdentity("## Why\n\nSome rationale.\n", { changeName: CHANGE_NAME, branch: BRANCH }).issue,
    "is missing `## Batch Approval Ledger`",
  );
  assert.equal(evaluateBatchApprovalLedgerShape("## Why\n\nSome rationale.\n", { archiveName: ARCHIVE_NAME_WITH_DATE }), "absent");
  // Missing `kind`.
  const noKind = ledgerBody(withLegacy).split("\n").filter((line) => !line.startsWith("kind:")).join("\n");
  assert.equal(identityIssue(noKind), "has missing or mismatched `kind`");
  assert.equal(shapeVerdict(noKind), "shapeless");
  // Mismatched named_change / branch.
  const wrongName = ledgerBody(withLegacy).replace(`named_change: ${CHANGE_NAME}`, "named_change: other-change");
  assert.equal(identityIssue(wrongName), "has missing or mismatched `named_change`");
  assert.equal(shapeVerdict(wrongName), "shapeless");
  assert.equal(identityIssue(ledgerBody(withLegacy).replace(`branch: ${BRANCH}`, "branch: chore/other")), "has missing or mismatched `branch`");
  // Empty excludes while covers carries the legacy token.
  assert.equal(identityIssue(ledgerBody({ ...withLegacy, excludes: [] })), "has empty or missing `excludes`");
  // Missing excludes key entirely.
  const noExcludes = ledgerBody(withLegacy).split("\n").filter((line) => line !== "excludes:" && !/^  - (merge|release)$/.test(line)).join("\n");
  assert.equal(shapeVerdict(noExcludes), "shapeless");
  // Empty covers while excludes carries the legacy token.
  assert.equal(identityIssue(ledgerBody({ covers: [], excludes: ["merge", "external_disclosure"] })), "has empty or missing `covers`");
  assert.equal(shapeVerdict(ledgerBody({ covers: [], excludes: ["merge", "external_disclosure"] })), "shapeless");
});

test("Retired ledger item is rejected with a removal-only fix: N/A sentinel, legal items and a legacy-looking substring are not rejected", () => {
  assert.equal(identityIssue(NA_LEDGER), "still says `N/A: no batch approval selected`");
  assert.equal(shapeVerdict(NA_LEDGER), "ok");
  // Whole-item comparison: a longer, unrelated item that merely contains a legacy token is not a legacy item.
  const body = ledgerBody({ covers: ["worktree", "local_commit_external_disclosure_review"] });
  assert.equal(identityIssue(body), "");
  assert.equal(shapeVerdict(body), "ok");
});

// ---------------------------------------------------------------------------
// evaluateLiteScopeRecord / readLiteScopeRecord (design.md D5)
// ---------------------------------------------------------------------------

const LITE_COVERS = "worktree,local_commit,pre_pr_gate,first_push,pr_create_update,workflow_watch,post_pr_completion_gate,scenario_walkthrough";
const LITE_EXCLUDES = "merge,release,destructive,secrets,cross_repo_write";
const LITE_CHANGE = "lite-record-change";
const LITE_BRANCH = "feature/lite-record-change";

function liteLine({ named = LITE_CHANGE, branch = LITE_BRANCH, covers = LITE_COVERS, excludes = LITE_EXCLUDES, kind = "same-change-dp-change-batch", scope = "same-repo" } = {}) {
  return `kind=${kind}; named_change=${named}; branch=${branch}; repo_scope=${scope}; covers=${covers}; excludes=${excludes}`;
}

function evalLite(content, identity = { changeName: LITE_CHANGE, branch: LITE_BRANCH }) {
  return evaluateLiteScopeRecord(content, identity);
}

test("Record evaluation separates match, mismatch, malformed, and missing: a well-formed record for the same change name and branch is a match", () => {
  for (const content of [liteLine(), `${liteLine()}\n`, `${liteLine()}\r\n`]) {
    const result = evalLite(content);
    assert.equal(result.status, "match", JSON.stringify(result));
    assert.equal(result.issue, "");
  }
});

test("Record evaluation separates match, mismatch, malformed, and missing: a well-formed record for another change name or branch is a mismatch with an issue", () => {
  const otherName = evalLite(liteLine({ named: "some-other-change" }));
  assert.equal(otherName.status, "mismatch");
  assert.match(otherName.issue, /named_change/);
  const otherBranch = evalLite(liteLine({ branch: "feature/some-other-branch" }));
  assert.equal(otherBranch.status, "mismatch");
  assert.match(otherBranch.issue, /branch/);
  assert.doesNotMatch(otherBranch.issue, /named_change/);
});

test("Record evaluation separates match, mismatch, malformed, and missing: missing, reordered, duplicate or unknown fields are malformed with an issue", () => {
  const fields = liteLine().split("; ");
  const cases = {
    "missing field": fields.filter((field) => !field.startsWith("repo_scope=")).join("; "),
    "reordered fields": [fields[1], fields[0], ...fields.slice(2)].join("; "),
    "duplicate field": [...fields, "branch=feature/dup"].join("; "),
    "unknown field": [...fields, "owner=someone"].join("; "),
    "wrong kind": liteLine({ kind: "cross-repo-dp-change-batch" }),
    "wrong repo_scope": liteLine({ scope: "cross-repo" }),
    "empty content": "",
    "no fields": "just some prose",
  };
  for (const [label, content] of Object.entries(cases)) {
    const result = evalLite(content);
    assert.equal(result.status, "malformed", `${label}: ${JSON.stringify(result)}`);
    assert.notEqual(result.issue, "", label);
  }
});

test("Record evaluation separates match, mismatch, malformed, and missing: an empty covers or excludes, empty or spaced list items are malformed", () => {
  for (const [label, content] of Object.entries({
    "empty covers": liteLine({ covers: "" }),
    "empty excludes": liteLine({ excludes: "" }),
    "empty list item": liteLine({ covers: "worktree,,local_commit" }),
    "trailing comma": liteLine({ excludes: "merge," }),
    "spaced list": liteLine({ covers: "worktree, local_commit" }),
  })) {
    const result = evalLite(content);
    assert.equal(result.status, "malformed", `${label}: ${JSON.stringify(result)}`);
    assert.notEqual(result.issue, "", label);
  }
  assert.match(evalLite(liteLine({ covers: "" })).issue, /covers/);
  assert.match(evalLite(liteLine({ excludes: "" })).issue, /excludes/);
});

test("Record evaluation separates match, mismatch, malformed, and missing: a retired ledger token in covers or excludes is malformed and named as written", () => {
  for (const token of LEGACY_TOKENS) {
    for (const key of ["covers", "excludes"]) {
      const list = (base) => `${base},${token}`;
      const content = liteLine(key === "covers" ? { covers: list(LITE_COVERS) } : { excludes: list(LITE_EXCLUDES) });
      const result = evalLite(content);
      assert.equal(result.status, "malformed", `${token} in ${key}: ${JSON.stringify(result)}`);
      assert.ok(result.issue.includes(token), result.issue);
      assert.ok(result.issue.includes("retired item; delete it"), result.issue);
      assert.doesNotMatch(result.issue, /adopt/i);
    }
  }
  const written = evalLite(liteLine({ covers: `${LITE_COVERS},Reviewer-Owned-Sticky-Write-Back` }));
  assert.equal(written.status, "malformed");
  assert.ok(written.issue.includes("Reviewer-Owned-Sticky-Write-Back"), written.issue);
});

test("Record evaluation separates match, mismatch, malformed, and missing: a BOM or a second line is malformed", () => {
  for (const [label, content] of Object.entries({
    "BOM": `﻿${liteLine()}\n`,
    "second line": `${liteLine()}\nsecond line\n`,
    "blank second line": `${liteLine()}\n\n`,
    "two records": `${liteLine()}\n${liteLine()}\n`,
    "leading blank line": `\n${liteLine()}\n`,
  })) {
    const result = evalLite(content);
    assert.equal(result.status, "malformed", `${label}: ${JSON.stringify(result)}`);
    assert.notEqual(result.issue, "", label);
  }
});

test("Record evaluation separates match, mismatch, malformed, and missing: malformed outranks mismatch, and the record is judged by its content only", () => {
  const result = evalLite(`${liteLine({ branch: "feature/some-other-branch" })}\nsecond line\n`);
  assert.equal(result.status, "malformed");
  // The evaluator never looks at a Bash command string: command-looking text is just a malformed record.
  assert.equal(evalLite("node .devpro/scripts/grant-lite-disclosure.mjs --batch").status, "malformed");
});

function withLiteChangeFolder(fn) {
  const root = makeTempDir("lite-scope-record-");
  try {
    const folder = path.join(root, "openspec", "changes", LITE_CHANGE);
    mkdirSync(folder, { recursive: true });
    return fn({ root, folder, record: path.join(folder, "lite-scope.md") });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("An archived lite record is still found after the folder moves into archive/", () => {
  // 歸檔時 lite-scope.md 會跟著搬進 archive/；只讀 active 路徑會讓已歸檔的
  // lite change 回 missing（2026-10-24 add-principal-delegation PR-1 之後的缺口）。
  const read = readLiteScopeRecord;
  const root = makeTempDir("lite-scope-archived-");
  try {
    const archived = path.join(root, "openspec", "changes", "archive", LITE_CHANGE);
    mkdirSync(archived, { recursive: true });
    writeFileSync(path.join(archived, "lite-scope.md"), `${liteLine()}\n`);
    const result = read(root, { changeName: LITE_CHANGE, branch: LITE_BRANCH });
    assert.equal(result.status, "match");
    assert.match(result.recordPath, /archive/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Record evaluation separates match, mismatch, malformed, and missing: the file helper reports an absent file as missing and authorizes nothing", () => {
  const read = readLiteScopeRecord;
  withLiteChangeFolder(({ root }) => {
    const result = read(root, { changeName: LITE_CHANGE, branch: LITE_BRANCH });
    assert.equal(result.status, "missing");
    assert.notEqual(result.status, "match");
  });
});

test("Record evaluation separates match, mismatch, malformed, and missing: the file helper evaluates a regular file's content", () => {
  const read = readLiteScopeRecord;
  withLiteChangeFolder(({ root, record }) => {
    writeFileSync(record, `${liteLine()}\n`);
    assert.equal(read(root, { changeName: LITE_CHANGE, branch: LITE_BRANCH }).status, "match");
    assert.equal(read(root, { changeName: LITE_CHANGE, branch: "feature/other" }).status, "mismatch");
    writeFileSync(record, `${liteLine()}\nsecond line\n`);
    assert.equal(read(root, { changeName: LITE_CHANGE, branch: LITE_BRANCH }).status, "malformed");
  });
});

test("Record evaluation separates match, mismatch, malformed, and missing: a symlink named lite-scope.md is malformed even when it points at a valid matching record", () => {
  const read = readLiteScopeRecord;
  withLiteChangeFolder(({ root, folder, record }) => {
    const target = path.join(root, "valid-record.txt");
    writeFileSync(target, `${liteLine()}\n`);
    symlinkSync(target, record);
    const result = read(root, { changeName: LITE_CHANGE, branch: LITE_BRANCH });
    assert.equal(result.status, "malformed", "a symlink must not be followed to the valid record behind it");
    assert.notEqual(result.issue, "");
    assert.ok(folder);
  });
});

test("Record evaluation separates match, mismatch, malformed, and missing: a directory named lite-scope.md is malformed", () => {
  const read = readLiteScopeRecord;
  withLiteChangeFolder(({ root, record }) => {
    mkdirSync(record);
    const result = read(root, { changeName: LITE_CHANGE, branch: LITE_BRANCH });
    assert.equal(result.status, "malformed");
    assert.notEqual(result.issue, "");
  });
});
