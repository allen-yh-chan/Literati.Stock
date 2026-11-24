import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { repoPath } from "./lib/repo-root.mjs";
function proposalMiniPath(changeName) {
  const activePath = `openspec/changes/${changeName}/proposal-mini.md`;
  if (existsSync(repoPath(activePath))) return activePath;

  const archiveRoot = repoPath("openspec/changes/archive");
  if (existsSync(archiveRoot)) {
    const archived = readdirSync(archiveRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.endsWith(`-${changeName}`))
      .map((entry) => entry.name)
      .sort()
      .at(-1);
    if (archived) return `openspec/changes/archive/${archived}/proposal-mini.md`;
  }

  return activePath;
}

const files = {
  dpChange: ".devpro/agent-skills/devpro-workflows/change/SKILL.md",
  dpPrePr: ".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md",
  gitBranchFlow: ".devpro/agent-rules/git-branch-and-pr-flow.md",
  postPrGate: ".devpro/agent-rules/post-pr-completion-gate.md",
  proposalTemplate: ".devpro/agent-rules/proposal-template.md",
  preToolGate: ".devpro/scripts/hooks/pre-tool-gate.mjs",
  hookPreToolGateTest: ".devpro/scripts/tests/hook-pre-tool-gate.test.mjs",
  canonicalSpec: "openspec/specs/openspec-flow/spec.md",
  rationalizations: ".devpro/agent-rules/ai-autonomy-rationalizations.md",
  sessionPendingLifecycle: ".devpro/agent-rules/session-pending-lifecycle.md",
  proposalMini: proposalMiniPath("remove-gh-body"),
  reentryPrewriteProposalMini: proposalMiniPath("strengthen-diagnosis-reentry-prewrite-gate"),
};

function read(name) {
  return readFileSync(repoPath(files[name]), "utf8");
}

function assertIncludes(content, tokens, label) {
  for (const token of tokens) {
    assert.ok(content.includes(token), `${label} missing ${token}`);
  }
}

function h2Section(content, heading) {
  const match = new RegExp(`^##[\\t ]+${heading.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}[\\t ]*$`, "m")
    .exec(content);
  assert.ok(match, `missing ## ${heading}`);
  const rest = content.slice(match.index + match[0].length);
  const next = rest.search(/^##[\t ]+/m);
  return next === -1 ? rest : rest.slice(0, next);
}

const standardLedgerCarriers = ["dpChange", "proposalTemplate"];
const standardExclusions = ["merge", "release", "destructive", "secrets", "cross_repo_write"];

function parseStandardLedger(content, carrier) {
  const match = content.match(/^covers:\n((?:  - [^\n]+\n)+)excludes:\n((?:  - [^\n]+(?:\n|$))+)/m);
  assert.ok(match, `${carrier} missing contiguous covers/excludes ledger sections`);
  const entries = (block) => block.trimEnd().split("\n").map((line) => line.slice(4));
  return { covers: entries(match[1]), excludes: entries(match[2]) };
}

function assertWalkthroughCovered(content, carrier) {
  const ledger = parseStandardLedger(content, carrier);
  assert.ok(ledger.covers.includes("scenario_walkthrough"), `${carrier} covers missing scenario_walkthrough`);
  assert.ok(!ledger.excludes.includes("scenario_walkthrough"), `${carrier} excludes scenario_walkthrough`);
}

for (const name of standardLedgerCarriers) {
  test(`${name} standard batch ledger exactly covers scenario_walkthrough`, () => {
    assertWalkthroughCovered(read(name), files[name]);
  });

  test(`${name} coverage guard rejects scenario_walkthrough only in excludes`, () => {
    const mutated = read(name)
      .replace(/^  - scenario_walkthrough\n(?=excludes:)/m, "")
      .replace(/^excludes:\n/m, "excludes:\n  - scenario_walkthrough\n");
    assert.throws(() => assertWalkthroughCovered(mutated, files[name]), /covers missing scenario_walkthrough/);
  });
}

test("branch flow names scenario_walkthrough in whole-flow batch scope", () => {
  assert.match(
    read("gitBranchFlow"),
    /whole `\/devpro:change` flow batch approval[^\n]*`scenario_walkthrough`/,
    `${files.gitBranchFlow} missing scenario_walkthrough from whole-flow batch approval`,
  );
});

test("standard structured ledgers preserve every existing exclusion", () => {
  for (const name of standardLedgerCarriers) {
    const ledger = parseStandardLedger(read(name), files[name]);
    for (const exclusion of standardExclusions) {
      assert.ok(ledger.excludes.includes(exclusion), `${files[name]} excludes missing ${exclusion}`);
      assert.ok(!ledger.covers.includes(exclusion), `${files[name]} covers must not contain exclusion ${exclusion}`);
    }
  }

  assertIncludes(
    read("gitBranchFlow"),
    ["`merge`", "release promote", "destructive action", "secrets", "Cross-repo write"],
    files.gitBranchFlow,
  );
});


test("standard structured ledgers cover worktree and local_commit", () => {
  for (const name of standardLedgerCarriers) {
    const ledger = parseStandardLedger(read(name), files[name]);
    assert.ok(ledger.covers.includes("worktree"), `${files[name]} covers missing worktree`);
    assert.ok(ledger.covers.includes("local_commit"), `${files[name]} covers missing local_commit`);
  }
});

test("batch approval carriers reject the obsolete always-independent walkthrough polarity", () => {
  assert.doesNotMatch(
    read("dpChange"),
    /^.*Scenario Walkthrough yes\/no.*獨立停點.*$/m,
    `${files.dpChange} still says Scenario Walkthrough yes/no is always an independent stop`,
  );
  assert.doesNotMatch(
    read("dpPrePr"),
    /^.*Scenario Walkthrough Part 2.*獨立 user decision.*$/m,
    `${files.dpPrePr} still says Scenario Walkthrough Part 2 is always an independent user decision`,
  );
});

test("devpro:change records structured batch approval ledger and forbids narrowing", () => {
  assertIncludes(
    read("dpChange"),
    [
      "Batch Approval Ledger",
      "kind: same-change-dp-change-batch",
      "worktree",
      "local_commit",
      "first_push",
      "pr_create_update",
      "post_pr_completion_gate",
      "Approval scope narrowing prohibition",
    ],
    files.dpChange,
  );
});

// Both ledger templates carry exactly one action list: the retired same-repo
// external-disclosure items are retired ledger items and are not covered.
function assertSetEqual(actual, expected, label) {
  const missing = expected.filter((value) => !actual.includes(value));
  const extra = actual.filter((value) => !expected.includes(value));
  assert.deepEqual({ missing, extra }, { missing: [], extra: [] }, `${label}: missing ${missing.join(",") || "-"}; extra ${extra.join(",") || "-"}`);
}
const standardCovers = ["worktree", "local_commit", "pre_pr_gate", "first_push", "pr_create_update", "workflow_watch", "post_pr_completion_gate", "scenario_walkthrough"];

for (const name of standardLedgerCarriers) {
  test(`${name} standard batch ledger covers and excludes are exactly the retired-item-free lists`, () => {
    const ledger = parseStandardLedger(read(name), files[name]);
    assertSetEqual(ledger.covers, standardCovers, `${files[name]} covers`);
    assertSetEqual(ledger.excludes, standardExclusions, `${files[name]} excludes`);
  });
}

test("set-equality fixture names an inserted legacy item and a dropped item", () => {
  assert.throws(() => assertSetEqual([...standardCovers, "reviewer_sticky_write_back"], standardCovers, "fixture"), /extra reviewer_sticky_write_back/);
  assert.throws(() => assertSetEqual(standardCovers.filter((item) => item !== "first_push"), standardCovers, "fixture"), /missing first_push/);
});

test("ledger templates and the change skill carry no retired ledger vocabulary", () => {
  for (const name of ["dpChange", "proposalTemplate", "gitBranchFlow"]) {
    const content = read(name);
    for (const retired of [
      "same_repo_exact_pr_external_disclosure",
      "reviewer_sticky_write_back",
      "reviewer_owned_sticky_write_back",
      "ExternalDisclosureApproval",
      "grant-lite-disclosure",
    ]) {
      assert.equal(content.includes(retired), false, `${files[name]} must not carry retired ${retired}`);
    }
  }
});

test("pre-pr and post-pr inspect ledger before asking again", () => {
  assertIncludes(
    read("dpPrePr"),
    [
      "Batch Approval Carry-Forward Precheck",
      "MUST NOT ask again",
      "Anti idle-stop",
      "gate progress",
      "Ready Response",
    ],
    files.dpPrePr,
  );

  // The post-PR gate no longer waits for any second-review approval, so its former
  // "inspect the ledger before asking again" clauses are retired; the surviving
  // anchors keep the anti idle-stop and workflow-N/A bridge-to-next-action rule.
  assertIncludes(
    read("postPrGate"),
    [
      "idle-stop",
      "workflow `N/A`",
    ],
    files.postPrGate,
  );
});

test("proposal template makes batch scope machine-checkable", () => {
  assertIncludes(
    read("proposalTemplate"),
    [
      "## Batch Approval Ledger",
      "N/A: no batch approval selected",
      "kind: same-change-dp-change-batch",
      "Batch approval prose MUST NOT narrow this ledger",
    ],
    files.proposalTemplate,
  );
});

test("proposal template Required hook headings includes Batch Approval Ledger", () => {
  const content = read("proposalTemplate");
  const match = /^Required hook headings:.*$/m.exec(content);
  assert.ok(match, `${files.proposalTemplate} missing Required hook headings line`);
  assert.ok(
    match[0].includes("`## Batch Approval Ledger`"),
    `${files.proposalTemplate} Required hook headings line missing \`## Batch Approval Ledger\``,
  );
});

test("openspec locks ledger against local-only narrowing", () => {
  assertIncludes(
    read("canonicalSpec"),
    [
      "Batch Approval Ledger Prevents Local-Only Narrowing",
      "Pre-PR Uses Ledger Before Asking Again",
      "custom scope explicitly excludes that action",
    ],
    files.canonicalSpec,
  );
});

test("remove-gh-body proposal carries whole-flow ledger and no contradiction", () => {
  const content = read("proposalMini");
  assertIncludes(
    content,
    [
      "## Batch Approval Ledger",
      "kind: same-change-dp-change-batch",
      "named_change: remove-gh-body",
      "branch: chore/remove-gh-body",
      "first_push",
      "pr_create_update",
    ],
    files.proposalMini,
  );

  assert.equal(content.includes("Push/PR/merge/release remain out of scope"), false);
  assert.equal(content.includes("Push/PR out of scope"), false);
});

test("session-pending batch approval pre-write gate is mechanically wired", () => {
  assertIncludes(
    read("preToolGate"),
    [
      "session-pending-batch-ledger-prewrite",
      "Gate SP (Session Pending Batch Approval Ledger)",
      "notes/session-pending.md",
      "N/A: no batch approval selected",
      "openspec/changes/${changeName}/",
    ],
    files.preToolGate,
  );

  assertIncludes(
    read("hookPreToolGateTest"),
    [
      "Gate SP: claimed session-pending batch approval blocks N/A ledger before implementation write",
      "Gate SP: claimed session-pending batch approval allows OpenSpec correction write",
      "Gate SP: valid batch approval ledger permits implementation write",
      "Gate SP: unclaimed pending item does not block implementation write",
    ],
    files.hookPreToolGateTest,
  );
});

test("reentry-prewrite proposal carries PR-merge batch approval ledger", () => {
  const content = read("reentryPrewriteProposalMini");
  const ledger = h2Section(content, "Batch Approval Ledger");
  assertIncludes(
    content,
    [
      "## Batch Approval Ledger",
      "kind: same-change-dp-change-batch",
      "named_change: strengthen-diagnosis-reentry-prewrite-gate",
      "branch: chore/strengthen-diagnosis-reentry-prewrite-gate",
      "repo_scope: same-repo",
      "pr_merge",
      "release",
      "destructive",
      "secrets",
      "cross_repo_write",
    ],
    files.reentryPrewriteProposalMini,
  );
  assert.equal(ledger.includes("N/A: no batch approval selected"), false);
});

test("rationalizations reject PASS-as-terminal under batch coverage", () => {
  assertIncludes(
    read("rationalizations"),
    [
      "sticky PASS",
      "可以停了",
      "gate progress",
      "same-change-dp-change-batch",
      "Carry-Forward Precheck",
    ],
    files.rationalizations,
  );
});

test("session-pending approval records use the `approval:` sub-item Gate SP reads", () => {
  const lifecycle = read("sessionPendingLifecycle");
  const heading = lifecycle.indexOf("### 批次授權紀錄\n");
  assert.ok(heading >= 0, `${files.sessionPendingLifecycle} missing ### 批次授權紀錄`);
  const section = lifecycle.slice(heading, lifecycle.indexOf("\n### ", heading + 1));
  assertIncludes(
    section,
    ["`approval:` 子項", "code fence 外", "sessionPendingBlockRecordsBatchApproval", "議題文字，不算紀錄"],
    files.sessionPendingLifecycle,
  );
  assertIncludes(
    read("dpChange"),
    ["只認 code fence 外的 `approval:` 子項", "`session-pending-lifecycle.md` §批次授權紀錄"],
    files.dpChange,
  );
  assert.match(read("preToolGate"), /const SESSION_PENDING_APPROVAL_LINE = \/\^\[\\t \]\*\(\?:\[-\*\]\[\\t \]\*\)\?approval:\/i;/);
});
