/**
 * One case table for the per-PR waiver comparison, run through Gate 4c
 * (hook-pre-tool-gate-pr-body-template.test.mjs) and the MCP create_pr client
 * policy (github-client-policy.test.mjs), so both paths are held to the same
 * decisions and the same message facts (openspec-flow requirement "PR Creation
 * Compares Per-PR Waiver Lines With Answer-Time Records").
 *
 * A case describes the fixture (branch, whether a checks file is tracked, the
 * notes/session-pending.md content of the main checkout), the two evidence line
 * statuses, and the expected outcome. Harnesses compose the body and the repo.
 */

export const NAME = "waiver-case";
export const BRANCH = `chore/${NAME}`;
export const DEV_GATE_PREFIX = "DEV deploy-verify gate";
export const CONSUMER_GATE_PREFIX = "Consumer pre-PR checks gate";

export const SCENARIO = {
  noRecord: "A waiver without a matching answer-time record blocks PR creation",
  matching: "A matching answer-time record lets the waiver pass",
  other: "A record of another reason, kind, or change does not match",
  unlocatable: "Records that cannot be located, read, or told apart block only waiver lines",
  consumer: "Each Consumer release needs its own record",
  sourceOff: "Source repository and rigor off do not compare waiver records",
  boundary: "A record entry that also claims another change or is bound to another branch does not match",
};

export const devRecord = (reason, entryText = "staging deploy") => `  - dev_verification: waived: ${reason}; entry: ${entryText} (provenance: user)`;
export const consumerRecord = (reason) => `  - consumer_waiver: ${reason} (provenance: user)`;

export function entry({ heading = `${NAME} capsule`, claims = [NAME], prBranch = [BRANCH], records = [], extra = [] } = {}) {
  return [
    `## ${heading}`,
    ...claims.map((claim) => `  - claimed: ${claim}`),
    ...prBranch.map((value) => `  - pr_branch: ${value}`),
    ...records,
    ...extra,
    "",
  ].join("\n");
}

export const notesOf = (...entries) => `# Session pending\n\n${entries.join("\n")}`;

/** `notes` is null (no file), "unreadable" (a directory in place of the file) or the file text. */
const block = (gateName, includes = [], excludes = []) => ({ block: true, gate: gateName, includes, excludes });
const PASS = { block: false };
const RECORD_STEPS = ["ask the user", "Do not write a record for an unanswered waiver"];
const WAIVE = (reason) => `skipped per user decision: ${reason}`;

export const CASES = [
  // 1
  { scenario: SCENARIO.noRecord, id: "no notes file", notes: null, dev: WAIVE("X"),
    expect: block(DEV_GATE_PREFIX, [NAME, BRANCH, "notes/session-pending.md", ...RECORD_STEPS]) },
  { scenario: SCENARIO.noRecord, id: "notes file without a record for the change", notes: notesOf(entry({ records: [] })), dev: WAIVE("X"),
    expect: block(DEV_GATE_PREFIX, [NAME, BRANCH, "notes/session-pending.md", ...RECORD_STEPS]) },
  // 2
  { scenario: SCENARIO.matching, id: "matching waived record", notes: notesOf(entry({ records: [devRecord("X")] })), dev: WAIVE("X"), expect: PASS },
  { scenario: SCENARIO.matching, id: "observed failure before the waiver and a result after it", notes: notesOf(entry({ records: [devRecord("X")] })),
    dev: `deploy failed with HTTP 500; ${WAIVE("X (observed failure)")}`, expect: PASS },
  // 3
  { scenario: SCENARIO.other, id: "record of another reason", notes: notesOf(entry({ records: [devRecord("ANOTHER-REASON-ZQ")] })), dev: WAIVE("X"),
    expect: block(DEV_GATE_PREFIX, [NAME], ["ANOTHER-REASON-ZQ"]) },
  { scenario: SCENARIO.other, id: "a part that adds more checks after the recorded reason", notes: notesOf(entry({ records: [devRecord("UI smoke")] })),
    dev: WAIVE("UI smoke and unit tests"), expect: block(DEV_GATE_PREFIX, [NAME, "part 1 of 1"]) },
  { scenario: SCENARIO.other, id: "consumer_waiver record of the same reason for a DEV part", notes: notesOf(entry({ records: [consumerRecord("X")] })), dev: WAIVE("X"),
    expect: block(DEV_GATE_PREFIX, [NAME]) },
  { scenario: SCENARIO.other, id: "matching record held by the claimed entry of another change",
    notes: notesOf(entry({ heading: "OTHER-HEADING-ZQ", claims: ["alpha"], prBranch: ["chore/alpha"], records: [devRecord("X", "OTHER-ENTRY-ZQ")], extra: ["  - note: OTHER-NOTE-ZQ"] })),
    dev: WAIVE("X"), expect: block(DEV_GATE_PREFIX, [NAME], ["ZQ"]) },
  // 4
  { scenario: SCENARIO.unlocatable, id: "notes/session-pending.md cannot be read", notes: "unreadable", dev: WAIVE("X"),
    expect: block(DEV_GATE_PREFIX, ["notes/session-pending.md"]) },
  { scenario: SCENARIO.unlocatable, id: "two entries of the change carry records",
    notes: notesOf(entry({ heading: "first", records: [devRecord("X")] }), entry({ heading: "second", records: [consumerRecord("Y")] })),
    dev: WAIVE("X"), expect: block(DEV_GATE_PREFIX, [NAME]) },
  { scenario: SCENARIO.unlocatable, id: "two dev_verification lines", notes: notesOf(entry({ records: [devRecord("X"), devRecord("X")] })), dev: WAIVE("X"),
    expect: block(DEV_GATE_PREFIX, [NAME]) },
  { scenario: SCENARIO.unlocatable, id: "dev_verification line without the provenance suffix",
    notes: notesOf(entry({ records: ["  - dev_verification: waived: X; entry: staging deploy"] })), dev: WAIVE("X"),
    expect: block(DEV_GATE_PREFIX, [NAME]) },
  { scenario: SCENARIO.unlocatable, id: "release branch names no change", branch: "release/1.2.0", notes: notesOf(entry({ records: [devRecord("X")] })), dev: WAIVE("X"),
    expect: block(DEV_GATE_PREFIX, ["release/1.2.0"], ["ask the user"]) },
  ...["N/A: docs only", "pending: no DEV host yet", "deployed PR head to DEV; login path passed"].map((dev) => (
    { scenario: SCENARIO.unlocatable, id: `no waiver part in "${dev}" passes without any record`, notes: null, dev, expect: PASS })),
  // 5
  { scenario: SCENARIO.consumer, id: "two Consumer parts with one record", checksFile: true, dev: "N/A: docs only",
    consumer: `${WAIVE("no browser on CI")}; ${WAIVE("seed DB locked")}; user decision: confirmed no browser on CI`,
    notes: notesOf(entry({ records: [consumerRecord("no browser on CI")] })),
    expect: block(CONSUMER_GATE_PREFIX, [NAME, "part 2 of 2"]) },
  { scenario: SCENARIO.consumer, id: "two Consumer parts with two records", checksFile: true, dev: "N/A: docs only",
    consumer: `${WAIVE("no browser on CI")}; ${WAIVE("seed DB locked")}; user decision: confirmed no browser on CI`,
    notes: notesOf(entry({ records: [consumerRecord("no browser on CI"), consumerRecord("seed DB locked")] })), expect: PASS },
  { scenario: SCENARIO.consumer, id: "a confirmation note alone needs no record", checksFile: true, dev: "N/A: docs only",
    consumer: "user decision: confirmed unavailable browser; checks passed", notes: null, expect: PASS },
  // 9
  { scenario: SCENARIO.boundary, id: "one entry claims alpha and beta, PR from chore/beta", branch: "chore/beta",
    notes: notesOf(entry({ claims: ["alpha", "beta"], prBranch: ["chore/beta"], records: [devRecord("X")] })), dev: WAIVE("X"),
    expect: block(DEV_GATE_PREFIX, ["beta"]) },
  { scenario: SCENARIO.boundary, id: "pr_branch: feature/<name> against a PR from bugfix/<name>", branch: `bugfix/${NAME}`,
    notes: notesOf(entry({ prBranch: [`feature/${NAME}`], records: [devRecord("X")] })), dev: WAIVE("X"),
    expect: block(DEV_GATE_PREFIX, [NAME, `bugfix/${NAME}`, "Do not edit pr_branch:"], [`feature/${NAME}`]) },
  { scenario: SCENARIO.boundary, id: "entry without a pr_branch: line", notes: notesOf(entry({ prBranch: [], records: [devRecord("X")] })), dev: WAIVE("X"),
    expect: block(DEV_GATE_PREFIX, [NAME]) },
  { scenario: SCENARIO.boundary, id: "entry claiming only the change with the exact branch (bugfix/)", branch: `bugfix/${NAME}`,
    notes: notesOf(entry({ prBranch: [`bugfix/${NAME}`], records: [devRecord("X")] })), dev: WAIVE("X"), expect: PASS },
  { scenario: SCENARIO.boundary, id: "entry claiming only the change with the exact branch (chore/)",
    notes: notesOf(entry({ records: [devRecord("X")] })), dev: WAIVE("X"), expect: PASS },
];

// ── r2: merge and edit comparison (same decision function, same strings) ─────
//
// `head` is the PR head branch GitHub reports (gh `headRefName`, MCP `pr.head.ref`);
// `cross` is whether the PR head is in another repository (gh `isCrossRepository`,
// MCP `pr.head.repo` of another full_name). The gh harness runs the command from a
// checkout on `main`; the MCP harness has to run from the PR head checkout (the
// client policy requires branch === pr.head.ref), so only the head decides.

export const MERGE_SCENARIO = {
  noRecord: "A waiver added after the PR was opened blocks the merge without a record",
  matching: "A matching record lets the merge pass from a checkout on another branch",
  noWaiver: "A description without a waiver part passes the merge without reading records",
  elsewhere: "Records that are missing or bound elsewhere block the merge as at PR creation",
  fork: "A waiver on a PR whose head is in another repository blocks the merge",
};
export const EDIT_SCENARIO = {
  noRecord: "A description edit that adds an unmatched waiver is blocked before the edit",
  matching: "A description edit whose waiver matches a record passes",
  noWaiver: "A description edit without a waiver part passes without reading records",
};

export const MERGE_CHECK = "Merge-time check of PR #";
export const EDIT_CHECK = "Edit-time check of PR #";
const NO_HINTS = ["gh pr create", "DEVPRO_HOOK_BYPASS", "--body-file"];
const ACTUAL_ONLY = ["replace the waiver with the actual status"];
const NOT_ASKED = ["ask the user", "Do not write a record for an unanswered waiver"];

const blockFor = (check, includes = [], excludes = []) =>
  ({ block: true, gate: DEV_GATE_PREFIX, includes: [check, ...includes], excludes: [...NO_HINTS, ...excludes] });

function comparisonCases(scenario, check) {
  return [
    { scenario: scenario.noRecord, id: "entry of the change without a record", head: BRANCH, notes: notesOf(entry({ records: [] })), dev: WAIVE("X"),
      expect: blockFor(check, [NAME, BRANCH, "notes/session-pending.md", ...RECORD_STEPS]) },
    { scenario: scenario.noRecord, id: "a part that adds more checks after the recorded reason", head: BRANCH, notes: notesOf(entry({ records: [devRecord("UI smoke")] })),
      dev: WAIVE("UI smoke and unit tests"), expect: blockFor(check, [NAME, "part 1 of 1"]) },
    { scenario: scenario.matching, id: "matching waived record, PR head in this repository", head: BRANCH, notes: notesOf(entry({ records: [devRecord("X")] })), dev: WAIVE("X"), expect: PASS },
    { scenario: scenario.matching, id: "matching waived record after an observed failure", head: BRANCH, notes: notesOf(entry({ records: [devRecord("X")] })),
      dev: `deploy failed with HTTP 500; ${WAIVE("X (observed failure)")}`, expect: PASS },
    { scenario: scenario.fork ?? scenario.matching, id: "fork head with a matching record is blocked without a record step", head: BRANCH, cross: true,
      notes: notesOf(entry({ records: [devRecord("X")] })), dev: WAIVE("X"),
      expect: blockFor(check, ACTUAL_ONLY, NOT_ASKED) },
    { scenario: scenario.fork ?? scenario.matching, id: "the same record lets a same-repository head pass", head: BRANCH, cross: false,
      notes: notesOf(entry({ records: [devRecord("X")] })), dev: WAIVE("X"), expect: PASS },
    ...["N/A: docs only", "pending: no DEV host yet", "deployed PR head to DEV; login path passed"].map((dev) => (
      { scenario: scenario.noWaiver, id: `no waiver part in "${dev}" passes without any record`, head: BRANCH, notes: null, dev, expect: PASS })),
    { scenario: scenario.noWaiver, id: "a fork head without a waiver part passes", head: BRANCH, cross: true, notes: null, dev: "N/A: docs only", expect: PASS },
  ];
}

export const MERGE_CASES = [
  ...comparisonCases(MERGE_SCENARIO, MERGE_CHECK),
  { scenario: MERGE_SCENARIO.elsewhere, id: "no notes file", head: BRANCH, notes: null, dev: WAIVE("X"),
    expect: blockFor(MERGE_CHECK, [NAME, BRANCH, "notes/session-pending.md", ...RECORD_STEPS]) },
  { scenario: MERGE_SCENARIO.elsewhere, id: "the only record sits in the entry of another change", head: BRANCH,
    notes: notesOf(entry({ heading: "OTHER-HEADING-ZQ", claims: ["alpha"], prBranch: ["chore/alpha"], records: [devRecord("X", "OTHER-ENTRY-ZQ")] })), dev: WAIVE("X"),
    expect: blockFor(MERGE_CHECK, [NAME], ["ZQ"]) },
  { scenario: MERGE_SCENARIO.elsewhere, id: "the record has another reason", head: BRANCH, notes: notesOf(entry({ records: [devRecord("ANOTHER-REASON-ZQ")] })), dev: WAIVE("X"),
    expect: blockFor(MERGE_CHECK, [NAME], ["ZQ"]) },
  { scenario: MERGE_SCENARIO.elsewhere, id: "the entry is bound by pr_branch: to feature/<name>", head: `bugfix/${NAME}`,
    notes: notesOf(entry({ prBranch: [`feature/${NAME}`], records: [devRecord("X")] })), dev: WAIVE("X"),
    expect: blockFor(MERGE_CHECK, [NAME, `bugfix/${NAME}`, "Do not edit pr_branch:"], [`feature/${NAME}`]) },
  { scenario: MERGE_SCENARIO.elsewhere, id: "the PR head branch is release/<x>", head: "release/1.2.0", notes: notesOf(entry({ records: [devRecord("X")] })), dev: WAIVE("X"),
    expect: blockFor(MERGE_CHECK, ["release/1.2.0"], NOT_ASKED) },
];

// The edit table has no `fork` title of its own: the edit scenario "A description edit whose waiver
// matches a record passes" also requires the fork edit to be blocked without reading the record.
export const EDIT_CASES = comparisonCases(EDIT_SCENARIO, EDIT_CHECK);
