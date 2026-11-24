/**
 * pr-waiver-record-match.test.mjs
 *
 * Decision function that compares each `skipped per user decision:` part of the
 * DEV and Consumer evidence lines with the answer-time records of the change
 * (`perPrWaiverRecordError`). Fixtures are temp directories whose `.git` is
 * hand-built, so the default git probe runs for real without a child-process
 * import here (unit tier); no case reads the runner's own notes/session-pending.md.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as gate from "../lib/consumer-pre-pr-gate.mjs";

const SHA = "d".repeat(40);
const PROBLEM = {
  "git-query-failed": "the git query for the branch or the main checkout failed",
  "branch-without-change": "the branch names no change (detached HEAD, or not feature/, bugfix/, hotfix/ or chore/)",
  "file-missing": "notes/session-pending.md does not exist",
  "file-unreadable": "notes/session-pending.md cannot be read",
  "no-entry": "no claimed entry of this change carries a record",
  "ambiguous-entry": "the records of this change are not in exactly one entry that claims only this change",
  "malformed-record": "the record entry of this change lacks exactly one pr_branch: line, or its record of this kind is malformed",
  "branch-mismatch": "the record entry of this change is bound by pr_branch: to a different branch",
  "no-match": "no unused record of this kind matches this part (a part matches when it equals the recorded reason, or goes on after it only with a semicolon or an opening parenthesis)",
  "head-ref-missing": "GitHub reported no head branch for this PR",
  "cross-repository-head": "the PR head branch is in another repository, so no answer-time record of this checkout can belong to this PR",
};
const ASK = "ask the user this PR's waiver question";
const NO_RECORD_FOR_UNANSWERED = "Do not write a record for an unanswered waiver";

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), "pr-waiver-record-"));
}

// A repository whose HEAD names `branch` (or is detached when branch is null); a fresh
// directory per case, because the common-dir probe is memoised per cwd.
function makeMain({ branch = "chore/x", notes = null } = {}) {
  const root = tempDir();
  mkdirSync(path.join(root, ".git/objects"), { recursive: true });
  mkdirSync(path.join(root, ".git/refs/heads"), { recursive: true });
  writeFileSync(path.join(root, ".git/HEAD"), branch === null ? `${"0".repeat(39)}1\n` : `ref: refs/heads/${branch}\n`);
  if (notes !== null) writeNotes(root, notes);
  return root;
}

function writeNotes(root, text) {
  mkdirSync(path.join(root, "notes"), { recursive: true });
  writeFileSync(path.join(root, "notes/session-pending.md"), text);
}

// A linked worktree of `main`, with its own HEAD and its own (unused) notes/.
function makeLinkedWorktree(main, branch) {
  const wt = path.join(tempDir(), "wt");
  const admin = path.join(main, ".git/worktrees/wt");
  mkdirSync(admin, { recursive: true });
  mkdirSync(wt, { recursive: true });
  writeFileSync(path.join(admin, "HEAD"), `ref: refs/heads/${branch}\n`);
  writeFileSync(path.join(admin, "commondir"), "../..\n");
  writeFileSync(path.join(admin, "gitdir"), `${path.join(wt, ".git")}\n`);
  writeFileSync(path.join(wt, ".git"), `gitdir: ${admin}\n`);
  return wt;
}

const DEV_RECORD = (reason, entry = "staging deploy") => `  - dev_verification: waived: ${reason}; entry: ${entry} (provenance: user)`;
const CONSUMER_RECORD = (reason) => `  - consumer_waiver: ${reason} (provenance: user)`;

function entryText({ heading = "x capsule", claims = ["x"], prBranch = ["chore/x"], records = [], extra = [] } = {}) {
  return [
    `## ${heading}`,
    ...claims.map((claim) => `  - claimed: ${claim}`),
    ...prBranch.map((value) => `  - pr_branch:${value === "" ? "" : ` ${value}`}`),
    ...records,
    ...extra,
    "",
  ].join("\n");
}

const notesFile = (...entries) => `# Session pending\n\n${entries.join("\n")}`;

const body = (devStatus, consumerResult = null) => [
  "## Test Evidence",
  ...(devStatus === null ? [] : [`- DEV deploy-verify: HEAD ${SHA}; ${devStatus}`]),
  ...(consumerResult === null ? [] : [`- Consumer pre-PR checks: HEAD ${SHA}; ${consumerResult}`]),
  "",
  "## Manual Test",
  "- N/A",
  "",
].join("\n");

const waivedBody = (reason = "X") => body(`skipped per user decision: ${reason}`);

function run(bodyText, root, deps) {
  return gate.perPrWaiverRecordError(bodyText, root, deps);
}

function spies() {
  const calls = { git: 0, readFile: 0, resolveRoot: 0 };
  return {
    calls,
    deps: {
      git: () => { calls.git += 1; return { status: 1, stdout: "" }; },
      readFile: () => { calls.readFile += 1; throw new Error("readFile must not be called"); },
      resolveRoot: () => { calls.resolveRoot += 1; return { mainCheckoutRoot: "/nonexistent", identitySource: "fallback" }; },
    },
  };
}

function assertBlocked(result, { gateName = gate.DEV_GATE, problem, label = problem }) {
  assert.ok(result, `${label}: expected a block, got null`);
  assert.equal(result.gate, gateName, label);
  assert.ok(result.detail.includes(`: ${PROBLEM[problem]}. `), `${label}: wrong problem in ${result.detail}`);
  for (const other of Object.keys(PROBLEM)) {
    if (other !== problem) assert.ok(!result.detail.includes(PROBLEM[other]), `${label}: also names ${other}`);
  }
  return result.detail;
}

test("gate names are exported and match the existing Gate 4c prefixes", () => {
  assert.equal(gate.DEV_GATE, "DEV deploy-verify gate");
  assert.equal(gate.CONSUMER_GATE, "Consumer pre-PR checks gate");
});

// [Scenario: openspec-flow :: Records that cannot be located, read, or told apart block only waiver lines]
test("no waiver part: null, and git, readFile and the root probe are never called", () => {
  for (const [label, text] of [
    ["result summary", body("deployed to DEV; login passed", "project checks passed")],
    ["N/A", body("N/A: docs only")],
    ["pending", body("pending: no DEV host yet")],
    ["no evidence lines at all", "## Test Evidence\nAll tests pass.\n"],
    ["waiver text only in fenced code", body(null).replace("## Manual", `\`\`\`\nDEV deploy-verify: HEAD ${SHA}; skipped per user decision: X\n\`\`\`\n## Manual`)],
    ["waiver text outside Test Evidence", `## Notes\n- DEV deploy-verify: HEAD ${SHA}; skipped per user decision: X\n`],
    ["confirmation note only", body("N/A: docs only", "user decision: confirmed unavailable browser")],
  ]) {
    const { calls, deps } = spies();
    assert.equal(run(text, "/nonexistent", deps), null, label);
    assert.deepEqual(calls, { git: 0, readFile: 0, resolveRoot: 0 }, label);
  }
  const { calls, deps } = spies();
  for (const value of [undefined, null, 42, {}]) assert.equal(run(value, "/nonexistent", deps), null);
  assert.deepEqual(calls, { git: 0, readFile: 0, resolveRoot: 0 });
});

// [Scenario: openspec-flow :: A matching answer-time record lets the waiver pass]
test("a matching waived: record passes; so does an observed failure before the waiver and a longer part", () => {
  const root = makeMain({ notes: notesFile(entryText({ records: [DEV_RECORD("X")] })) });
  assert.equal(run(waivedBody("X"), root), null);
  assert.equal(run(body("deploy failed (HTTP 500); skipped per user decision: X (observed failure)"), root), null);
  assert.equal(run(body("skipped per user decision: X"), root), null);
  assert.equal(run(body("SKIPPED PER USER DECISION: X"), root), null, "the marker is case-insensitive");
});

test("only-this-change entry with the exact branch passes from a linked worktree, reading the main checkout notes", () => {
  const main = makeMain({ branch: "main", notes: notesFile(entryText({ prBranch: ["chore/x"], records: [DEV_RECORD("X")] })) });
  const wt = makeLinkedWorktree(main, "chore/x");
  writeNotes(wt, notesFile("## decoy\n  - claimed: x\n  - pr_branch: chore/x\n"));
  assert.equal(run(waivedBody("X"), wt), null);
  const reads = [];
  const readFile = (file, encoding) => { reads.push(file); return readFileSync(file, encoding); };
  assert.equal(run(waivedBody("X"), wt, { readFile }), null);
  assert.deepEqual(reads, [path.join(realpathSync(main), "notes", "session-pending.md")]);
});

// [Scenario: openspec-flow :: A waiver without a matching answer-time record blocks PR creation]
test("detail names the line kind, part numbers, change, branch, notes file and the two next steps", () => {
  const root = makeMain({ notes: notesFile(entryText({ records: [DEV_RECORD("another reason")] })) });
  const result = run(waivedBody("X marks the spot"), root);
  const detail = assertBlocked(result, { problem: "no-match" });
  assert.match(detail, /^DEV deploy-verify line, waiver part 1 of 1 \("X marks the spot"\): /);
  for (const needle of ["Looked for change x (branch chore/x)", "notes/session-pending.md", ASK, NO_RECORD_FOR_UNANSWERED, "replace the waiver with the actual status", "session-pending-lifecycle.md"]) {
    assert.ok(detail.includes(needle), `missing ${needle}`);
  }
  assert.ok(!detail.includes("another reason"), "the record content is not printed");
  assert.ok(detail.includes("pending: <what is missing>"), "DEV status hint");
});

test("a part longer than 80 characters is truncated in the detail", () => {
  const root = makeMain({ notes: notesFile(entryText({ records: [DEV_RECORD("nothing")] })) });
  const long = "q".repeat(120);
  const detail = assertBlocked(run(waivedBody(long), root), { problem: "no-match" });
  assert.ok(detail.includes(`("${"q".repeat(80)}"): `));
  assert.ok(!detail.includes("q".repeat(81)));
});

test("a Consumer line block uses the Consumer gate, kind and next step", () => {
  const root = makeMain({ notes: notesFile(entryText({ records: [CONSUMER_RECORD("other")] })) });
  const result = run(body("N/A: docs only", "skipped per user decision: unavailable browser"), root);
  const detail = assertBlocked(result, { gateName: gate.CONSUMER_GATE, problem: "no-match" });
  assert.match(detail, /^Consumer pre-PR checks line, waiver part 1 of 1 /);
  assert.ok(detail.includes("consumer-pre-pr-checks.md"));
});

// [Scenario: openspec-flow :: Records that cannot be located, read, or told apart block only waiver lines]
test("git-query-failed: a non-git directory, a failing git, and a fallback root; the file is never read", () => {
  const readFile = () => { throw new Error("readFile must not be called"); };
  const plain = tempDir();
  assertBlocked(run(waivedBody(), plain, { readFile }), { problem: "git-query-failed", label: "non-git directory" });
  assertBlocked(run(waivedBody(), plain, { readFile, git: () => ({ status: 128, stdout: "" }) }), { problem: "git-query-failed", label: "git status 128" });
  assertBlocked(run(waivedBody(), plain, { readFile, git: () => ({ status: null, stdout: "", error: new Error("spawn") }) }), { problem: "git-query-failed", label: "spawn error" });
  const root = makeMain({ notes: notesFile(entryText({ records: [DEV_RECORD("X")] })) });
  const detail = assertBlocked(run(waivedBody(), root, { readFile, resolveRoot: () => ({ mainCheckoutRoot: root, identitySource: "fallback" }) }), { problem: "git-query-failed", label: "fallback root" });
  assert.ok(detail.includes("Looked for change x (branch chore/x)"), "branch and change are known at the root step");
});

test("branch-without-change: detached HEAD, release branch and unprefixed branch name no change and offer no record step", () => {
  const notes = notesFile(entryText({ records: [DEV_RECORD("X")] }));
  for (const branch of [null, "release/1.2.0", "main", "feature"]) {
    const root = makeMain({ branch, notes });
    const detail = assertBlocked(run(waivedBody("X"), root), { problem: "branch-without-change", label: String(branch) });
    assert.ok(!detail.includes("ask the user"), `${branch}: no ask-the-user step`);
    assert.ok(!detail.includes(NO_RECORD_FOR_UNANSWERED), `${branch}: no record step`);
    assert.ok(detail.includes("replace the waiver with the actual status"), branch);
    assert.ok(detail.includes(`Looked for a change name in branch ${branch ?? "(detached)"}`), `${branch}: ${detail}`);
  }
});

test("file-missing when notes/session-pending.md does not exist, file-unreadable for any other read error", () => {
  const missing = makeMain();
  assertBlocked(run(waivedBody(), missing), { problem: "file-missing" });
  const unreadable = makeMain();
  mkdirSync(path.join(unreadable, "notes/session-pending.md"), { recursive: true });
  assertBlocked(run(waivedBody(), unreadable), { problem: "file-unreadable" });
  const denied = makeMain();
  const detail = assertBlocked(run(waivedBody(), denied, { readFile: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } }), { problem: "file-unreadable", label: "EACCES" });
  assert.ok(detail.includes("notes/session-pending.md"));
});

// [Scenario: openspec-flow :: A record of another reason, kind, or change does not match]
test("no-entry: no record, only another change's entry, or an unclaimed entry; nothing of the other entry is printed", () => {
  const other = entryText({ heading: "OTHER-ENTRY-HEADING-ZQ", claims: ["alpha"], prBranch: ["chore/alpha"], records: [DEV_RECORD("X", "OTHER-ENTRY-DEPLOY-ZQ")], extra: ["  - note: OTHER-ENTRY-NOTE-ZQ"] });
  const unclaimed = "## loose item\n  - decided: x\n" + `${DEV_RECORD("X")}\n  - pr_branch: chore/x\n`;
  for (const [label, notes] of [
    ["empty file", ""],
    ["entry of this change without a record", notesFile(entryText({ records: [] }))],
    ["another change carrying the matching record", notesFile(other)],
    ["unclaimed entry carrying the record", notesFile(unclaimed, other)],
  ]) {
    const root = makeMain({ notes });
    const detail = assertBlocked(run(waivedBody("X"), root), { problem: "no-entry", label });
    assert.ok(!/ZQ/.test(detail), `${label}: leaked another entry`);
  }
});

test("a fenced record or claimed line does not count", () => {
  const fenced = `## x capsule\n  - claimed: x\n  - pr_branch: chore/x\n\`\`\`\n${DEV_RECORD("X")}\n\`\`\`\n`;
  assertBlocked(run(waivedBody("X"), makeMain({ notes: notesFile(fenced) })), { problem: "no-entry", label: "fenced record" });
  const fencedClaim = `## x capsule\n\`\`\`\n  - claimed: x\n\`\`\`\n  - pr_branch: chore/x\n${DEV_RECORD("X")}\n`;
  assertBlocked(run(waivedBody("X"), makeMain({ notes: notesFile(fencedClaim) })), { problem: "no-entry", label: "fenced claim" });
  const extraFencedClaim = entryText({ records: [DEV_RECORD("X")], extra: ["```", "  - claimed: beta", "```"] });
  assert.equal(run(waivedBody("X"), makeMain({ notes: notesFile(extraFencedClaim) })), null, "a fenced foreign claim does not make the entry ambiguous");
});

// [Scenario: openspec-flow :: A record entry that also claims another change or is bound to another branch does not match]
test("ambiguous-entry: one entry that claims alpha and beta with a record originally alpha's, from chore/beta", () => {
  const notes = notesFile(entryText({ claims: ["alpha", "beta"], prBranch: ["chore/beta"], records: [DEV_RECORD("X")] }));
  const detail = assertBlocked(run(waivedBody("X"), makeMain({ branch: "chore/beta", notes })), { problem: "ambiguous-entry" });
  assert.ok(detail.includes("Looked for change beta (branch chore/beta)"));
  assertBlocked(run(waivedBody("X"), makeMain({ branch: "chore/alpha", notes })), { problem: "ambiguous-entry", label: "from chore/alpha" });
});

test("ambiguous-entry: a duplicated claimed line, and two entries of the change that both carry records", () => {
  assertBlocked(run(waivedBody("X"), makeMain({ notes: notesFile(entryText({ claims: ["x", "x"], records: [DEV_RECORD("X")] })) })), { problem: "ambiguous-entry", label: "duplicate claimed" });
  const two = notesFile(entryText({ heading: "first", records: [DEV_RECORD("X")] }), entryText({ heading: "second", records: [CONSUMER_RECORD("Y")] }));
  assertBlocked(run(waivedBody("X"), makeMain({ notes: two })), { problem: "ambiguous-entry", label: "two carrying entries" });
  const oneCarrier = notesFile(entryText({ heading: "first", records: [DEV_RECORD("X")] }), entryText({ heading: "second", records: [] }));
  assert.equal(run(waivedBody("X"), makeMain({ notes: oneCarrier })), null, "a second claimed entry without records is not ambiguous");
});

test("malformed-record: pr_branch: missing, duplicated or empty", () => {
  for (const [label, prBranch] of [["missing", []], ["two lines", ["chore/x", "chore/x"]], ["empty value", [""]]]) {
    const root = makeMain({ notes: notesFile(entryText({ prBranch, records: [DEV_RECORD("X")] })) });
    assertBlocked(run(waivedBody("X"), root), { problem: "malformed-record", label });
  }
});

test("branch-mismatch: pr_branch: feature/x against a PR from bugfix/x; the detail never prints the bound branch or suggests editing it", () => {
  const notes = notesFile(entryText({ prBranch: ["feature/x"], records: [DEV_RECORD("X")] }));
  const detail = assertBlocked(run(waivedBody("X"), makeMain({ branch: "bugfix/x", notes })), { problem: "branch-mismatch" });
  assert.ok(detail.includes("Do not edit pr_branch:"));
  assert.ok(!detail.includes("feature/x"));
  assert.ok(detail.includes("Looked for change x (branch bugfix/x)"));
  assert.ok(detail.includes(ASK));
  assert.ok(!/branch\s+feature/.test(detail));
  // exact equality also covers case and surrounding text
  for (const bound of ["Chore/x", "chore/x-2", "chore/x/y"]) {
    assertBlocked(run(waivedBody("X"), makeMain({ notes: notesFile(entryText({ prBranch: [bound], records: [DEV_RECORD("X")] })) })), { problem: "branch-mismatch", label: bound });
  }
});

test("pr_branch: chore/x against a PR from chore/x passes (surrounding whitespace in the value is trimmed)", () => {
  const notes = notesFile(entryText({ prBranch: ["chore/x   "], records: [DEV_RECORD("X")] }));
  assert.equal(run(waivedBody("X"), makeMain({ notes })), null);
});

test("the change name is the branch minus one of the four prefixes, compared by exact equality", () => {
  for (const prefix of ["feature", "bugfix", "hotfix", "chore"]) {
    const notes = notesFile(entryText({ claims: ["same-name"], prBranch: [`${prefix}/same-name`], records: [DEV_RECORD("X")] }));
    assert.equal(run(waivedBody("X"), makeMain({ branch: `${prefix}/same-name`, notes })), null, prefix);
  }
  const nested = notesFile(entryText({ claims: ["a/b"], prBranch: ["feature/a/b"], records: [DEV_RECORD("X")] }));
  assert.equal(run(waivedBody("X"), makeMain({ branch: "feature/a/b", notes: nested })), null, "the remainder after the prefix is the change name");
  const prefixOnly = notesFile(entryText({ claims: ["x"], records: [DEV_RECORD("X")] }));
  assertBlocked(run(waivedBody("X"), makeMain({ branch: "chore/xy", notes: prefixOnly })), { problem: "no-entry", label: "claimed x is not claimed xy" });
});

// [Scenario: openspec-flow :: A record of another reason, kind, or change does not match]
test("no-match: another reason, another kind, and a decision that is not waived:", () => {
  const entry = (...records) => notesFile(entryText({ records }));
  for (const [label, notes] of [
    ["another reason", entry(DEV_RECORD("Y"))],
    ["a consumer_waiver record of the same reason", entry(CONSUMER_RECORD("X"))],
    ["deploy-before-pr", entry("  - dev_verification: deploy-before-pr; entry: staging deploy (provenance: user)")],
    ["n/a decision", entry("  - dev_verification: n/a: docs only; entry: none (provenance: user)")],
    ["open-pr-pending decision", entry("  - dev_verification: open-pr-pending: no host; entry: none (provenance: user)")],
  ]) {
    assertBlocked(run(waivedBody("X"), makeMain({ notes })), { problem: "no-match", label });
  }
  const consumerLine = body("N/A: docs only", "skipped per user decision: X");
  assertBlocked(run(consumerLine, makeMain({ notes: entry(DEV_RECORD("X")) })), { gateName: gate.CONSUMER_GATE, problem: "no-match", label: "waived dev record does not match a Consumer part" });
});

test("malformed-record: two dev_verification: lines, a missing provenance, a value outside the closed vocabulary, a Consumer line without provenance", () => {
  const entry = (...records) => notesFile(entryText({ records }));
  for (const [label, notes] of [
    ["two dev lines", entry(DEV_RECORD("X"), DEV_RECORD("X"))],
    ["missing provenance", entry("  - dev_verification: waived: X; entry: staging deploy")],
    ["unknown decision", entry("  - dev_verification: skipped: X; entry: staging deploy (provenance: user)")],
    ["empty waived reason", entry("  - dev_verification: waived: ; entry: staging deploy (provenance: user)")],
    ["empty n/a reason", entry("  - dev_verification: n/a:; entry: staging deploy (provenance: user)")],
  ]) {
    assertBlocked(run(waivedBody("X"), makeMain({ notes })), { problem: "malformed-record", label });
  }
  const consumerBody = body("N/A: docs only", "skipped per user decision: X");
  for (const [label, record] of [["no provenance", "  - consumer_waiver: X"], ["empty reason", "  - consumer_waiver:  (provenance: user)"]]) {
    assertBlocked(run(consumerBody, makeMain({ notes: entry(record) })), { gateName: gate.CONSUMER_GATE, problem: "malformed-record", label });
  }
});

test("only the kind being compared is validated", () => {
  const brokenConsumer = notesFile(entryText({ records: [DEV_RECORD("X"), "  - consumer_waiver: no provenance here"] }));
  assert.equal(run(waivedBody("X"), makeMain({ notes: brokenConsumer })), null, "DEV compare ignores a broken Consumer record");
  const brokenDev = notesFile(entryText({ records: [DEV_RECORD("X"), DEV_RECORD("X"), CONSUMER_RECORD("Y")] }));
  assert.equal(run(body("N/A: docs only", "skipped per user decision: Y"), makeMain({ notes: brokenDev })), null, "Consumer compare ignores two dev lines");
});

test("a waiver reason may itself contain a semicolon; the last '; entry: ' starts the entry field", () => {
  const notes = notesFile(entryText({ records: [DEV_RECORD("seed DB locked; Playwright blocked", "staging deploy; ready")] }));
  assert.equal(run(waivedBody("seed DB locked; Playwright blocked"), makeMain({ notes })), null);
});

// [Scenario: openspec-flow :: Each Consumer release needs its own record]
test("each Consumer part needs its own record: one record blocks part 2 of 2, two records pass, a confirmation note needs none", () => {
  const consumerBody = body("N/A: docs only", "skipped per user decision: no browser on CI; skipped per user decision: seed DB locked; user decision: confirmed no browser on CI");
  const one = notesFile(entryText({ records: [CONSUMER_RECORD("no browser on CI")] }));
  const detail = assertBlocked(run(consumerBody, makeMain({ notes: one })), { gateName: gate.CONSUMER_GATE, problem: "no-match" });
  assert.match(detail, /waiver part 2 of 2 \("seed DB locked; user decision: confirmed no browser on CI"\)/);
  const two = notesFile(entryText({ records: [CONSUMER_RECORD("no browser on CI"), CONSUMER_RECORD("seed DB locked")] }));
  assert.equal(run(consumerBody, makeMain({ notes: two })), null);
  const same = notesFile(entryText({ records: [CONSUMER_RECORD("no browser on CI"), CONSUMER_RECORD("no browser on CI")] }));
  assertBlocked(run(consumerBody, makeMain({ notes: same })), { gateName: gate.CONSUMER_GATE, problem: "no-match", label: "one reason twice cannot satisfy two different parts" });
  const noteOnly = body("N/A: docs only", "user decision: confirmed no browser");
  assert.equal(run(noteOnly, "/nonexistent"), null);
});

test("DEV and Consumer waiver parts are compared in that order and the first unmatched part is reported", () => {
  const both = body("skipped per user decision: D", "skipped per user decision: C");
  const consumerOnly = notesFile(entryText({ records: [CONSUMER_RECORD("C")] }));
  assertBlocked(run(both, makeMain({ notes: consumerOnly })), { gateName: gate.DEV_GATE, problem: "no-match", label: "DEV part unmatched first" });
  const devOnly = notesFile(entryText({ records: [DEV_RECORD("D")] }));
  assertBlocked(run(both, makeMain({ notes: devOnly })), { gateName: gate.CONSUMER_GATE, problem: "no-match", label: "Consumer part unmatched" });
  const full = notesFile(entryText({ records: [DEV_RECORD("D"), CONSUMER_RECORD("C")] }));
  assert.equal(run(both, makeMain({ notes: full })), null);
});

test("a Consumer waiver line is compared on its own, without any checks file or DEV waiver part", () => {
  const notes = notesFile(entryText({ records: [] }));
  assertBlocked(run(body("N/A: docs only", "skipped per user decision: X"), makeMain({ notes })), { gateName: gate.CONSUMER_GATE, problem: "no-entry" });
});

// NFR-SC7: the runner's own repository is never read.
test("every case locates notes under the injected or temp main checkout, never the runner's repository", () => {
  const injected = tempDir();
  writeNotes(injected, notesFile(entryText({ records: [DEV_RECORD("X")] })));
  const seen = [];
  const deps = {
    git: () => ({ status: 0, stdout: "chore/x\n" }),
    resolveRoot: () => ({ mainCheckoutRoot: injected, identitySource: "git-common-dir" }),
    readFile: (file, encoding) => { seen.push(file); return readFileSync(file, encoding); },
  };
  assert.equal(run(waivedBody("X"), "/nonexistent-cwd", deps), null);
  assert.deepEqual(seen, [path.join(injected, "notes", "session-pending.md")]);
});

// ---- pure helpers ----

test("waiverParts: one part per case-insensitive marker, ending at the next marker or the line end", () => {
  assert.deepEqual(gate.waiverParts("HEAD abc; passed"), []);
  assert.deepEqual(gate.waiverParts("x; skipped per user decision: a"), [" a"]);
  assert.deepEqual(gate.waiverParts("a; skipped per user decision: b; c; SKIPPED PER USER DECISION: d e"), [" b; c; ", " d e"]);
  assert.deepEqual(gate.waiverParts("skipped per user decision:skipped per user decision:z"), ["", "z"]);
});

test("matchWaiverParts: NFC, whitespace collapsing, trimming", () => {
  assert.deepEqual(gate.matchWaiverParts(["café"], ["café"]), []);
  assert.deepEqual(gate.matchWaiverParts([" no   browser\t on CI "], ["no browser on CI"]), []);
  assert.deepEqual(gate.matchWaiverParts(["no browser"], ["  no\n browser  "]), []);
  assert.deepEqual(gate.matchWaiverParts(["Foo"], ["foo"]), [1], "the comparison is not case-folded");
});

test("matchWaiverParts: a longer part matches only when the rest starts with a semicolon or an opening parenthesis", () => {
  assert.deepEqual(gate.matchWaiverParts(["no browsers on CI"], ["no browser"]), [1]);
  assert.deepEqual(gate.matchWaiverParts(["no browser2"], ["no browser"]), [1]);
  assert.deepEqual(gate.matchWaiverParts(["no browseré"], ["no browser"]), [1]);
  assert.deepEqual(gate.matchWaiverParts(["no browser on CI"], ["no browser"]), [1], "more words after a space extend the reason");
  assert.deepEqual(gate.matchWaiverParts(["UI smoke and unit tests"], ["UI smoke"]), [1], "a reason does not cover a part that names more checks");
  assert.deepEqual(gate.matchWaiverParts(["UI smoke, unit tests"], ["UI smoke"]), [1]);
  assert.deepEqual(gate.matchWaiverParts(["UI smoke - and unit tests"], ["UI smoke"]), [1]);
  assert.deepEqual(gate.matchWaiverParts(["no browser."], ["no browser"]), [1]);
  assert.deepEqual(gate.matchWaiverParts(["no browser ; checks passed"], ["no browser"]), []);
  assert.deepEqual(gate.matchWaiverParts(["沒有瀏覽器（CI 無 GUI）"], ["沒有瀏覽器"]), [], "a full-width opening parenthesis");
  assert.deepEqual(gate.matchWaiverParts(["沒有瀏覽器；其餘通過"], ["沒有瀏覽器"]), [], "a full-width semicolon");
  assert.deepEqual(gate.matchWaiverParts(["沒有瀏覽器與單元測試"], ["沒有瀏覽器"]), [1], "more CJK text extends the reason");
  assert.deepEqual(gate.matchWaiverParts(["seed DB locked; Playwright — passed"], ["seed DB locked"]), []);
  assert.deepEqual(gate.matchWaiverParts(["no browser (observed failure)"], ["no browser"]), []);
  assert.deepEqual(gate.matchWaiverParts(["no browser"], ["no browser"]), []);
  assert.deepEqual(gate.matchWaiverParts(["short"], ["short and longer"]), [1], "a part shorter than the reason never matches");
});

test("matchWaiverParts: an empty reason never matches", () => {
  assert.deepEqual(gate.matchWaiverParts(["anything"], [""]), [1]);
  assert.deepEqual(gate.matchWaiverParts(["anything"], ["   "]), [1]);
  assert.deepEqual(gate.matchWaiverParts(["anything"], []), [1]);
});

test("matchWaiverParts: same-kind maximum bipartite matching, not greedy", () => {
  // Record 'a' fits both parts ('a; b; x' goes on with a semicolon after 'a'); record 'a; b' fits only the first.
  // First-fit greedy gives 'a' to the first part and strands the second part 'a' ([2]); maximum matching
  // gives 'a; b' to the first part. Only this order of parts and records tells the two apart (#3497).
  assert.deepEqual(gate.matchWaiverParts(["a; b; x", "a"], ["a", "a; b"]), []);
  // The cases below no longer overlap under the semicolon-or-parenthesis boundary; they stay as plain matches.
  assert.deepEqual(gate.matchWaiverParts(["a b; x", "a; y"], ["a", "a b"]), []);
  assert.deepEqual(gate.matchWaiverParts(["a; y", "a b; x"], ["a", "a b"]), []);
  assert.deepEqual(gate.matchWaiverParts(["a b; x", "a; y"], ["a b", "a"]), []);
});

test("matchWaiverParts: each record matches at most one part and unmatched part numbers are 1-based", () => {
  assert.deepEqual(gate.matchWaiverParts(["a", "a"], ["a"]), [2]);
  assert.deepEqual(gate.matchWaiverParts(["a", "b", "c"], ["a", "c"]), [2]);
  assert.deepEqual(gate.matchWaiverParts(["a", "b", "c"], []), [1, 2, 3]);
  assert.deepEqual(gate.matchWaiverParts([], ["a"]), []);
});

test("testEvidenceLines: lines of ## Test Evidence outside fenced code, list marker stripped, by prefix", () => {
  const text = `## Test Evidence\n- DEV deploy-verify: HEAD ${SHA}; N/A: x\n* Consumer pre-PR checks: HEAD ${SHA}; ok\n\`\`\`\nDEV deploy-verify: HEAD ${SHA}; fenced\n\`\`\`\n## Other\nDEV deploy-verify: HEAD ${SHA}; elsewhere\n`;
  assert.deepEqual(gate.testEvidenceLines(text, "DEV deploy-verify:"), [`DEV deploy-verify: HEAD ${SHA}; N/A: x`]);
  assert.deepEqual(gate.testEvidenceLines(text, "Consumer pre-PR checks:"), [`Consumer pre-PR checks: HEAD ${SHA}; ok`]);
  assert.deepEqual(gate.testEvidenceLines("no sections", "DEV deploy-verify:"), []);
});

// ---- r2: head ref, cross-repository head, merge and edit outer strings, checkout identity ----

const gitSpy = () => {
  const calls = [];
  return { calls, git: (cwd, args) => { calls.push(args); return { status: 1, stdout: "" }; } };
};
const runWith = (bodyText, root, deps, options) => gate.perPrWaiverRecordError(bodyText, root, deps, options);
const ACTUAL_STATUS_ONLY = (detail, label) => {
  assert.ok(detail.includes("replace the waiver with the actual status"), `${label}: names the actual-status step`);
  assert.ok(!detail.includes("ask the user"), `${label}: no ask-the-user step`);
  assert.ok(!detail.includes(NO_RECORD_FOR_UNANSWERED), `${label}: no record step`);
  assert.ok(!detail.includes("session-pending-lifecycle.md"), `${label}: no record-writing pointer`);
};

// [Scenario: openspec-flow :: A matching record lets the merge pass from a checkout on another branch]
test("options.branch wins: git branch --show-current is not run, and the head ref (not the checkout branch) locates the entry", () => {
  const notes = notesFile(entryText({ records: [DEV_RECORD("X")] }));
  const main = makeMain({ branch: "main", notes });
  const { calls, git } = gitSpy();
  assert.equal(runWith(waivedBody("X"), main, { git }, { branch: "chore/x" }), null, "checkout on main, PR head chore/x");
  assert.ok(!calls.some((args) => args.includes("branch")), `git branch must not run, got ${JSON.stringify(calls)}`);
  assert.equal(runWith(waivedBody("X"), main, {}, { branch: "chore/x" }), null, "real git probe path also passes");
  // The head ref decides: a checkout on chore/x does not rescue a PR whose head is chore/y.
  const onX = makeMain({ branch: "chore/x", notes });
  const detail = assertBlocked(runWith(waivedBody("X"), onX, {}, { branch: "chore/y" }), { problem: "no-entry" });
  assert.ok(detail.includes("Looked for change y (branch chore/y)"), detail);
  // pr_branch: is compared with the head ref.
  const bound = makeMain({ branch: "main", notes: notesFile(entryText({ prBranch: ["feature/x"], records: [DEV_RECORD("X")] })) });
  assertBlocked(runWith(waivedBody("X"), bound, {}, { branch: "chore/x" }), { problem: "branch-mismatch" });
  // The option only applies when it is an own property; without it git decides as before.
  assert.equal(runWith(waivedBody("X"), onX, {}, {}), null);
  assert.equal(runWith(waivedBody("X"), onX), null);
});

// [Scenario: openspec-flow :: An unreadable description or a missing head branch blocks the merge]
test("head-ref-missing: an empty, non-string or undefined head ref blocks a waiver with only the actual-status step; no waiver means no block", () => {
  const notes = notesFile(entryText({ records: [DEV_RECORD("X")] }));
  for (const branch of ["", undefined, null, 42, {}, ["chore/x"]]) {
    const root = makeMain({ notes });
    const { calls, deps } = spies();
    const detail = assertBlocked(runWith(waivedBody("X"), root, deps, { branch }), { problem: "head-ref-missing", label: String(branch) });
    assert.deepEqual(calls, { git: 0, readFile: 0, resolveRoot: 0 }, `${String(branch)}: no git, no file`);
    ACTUAL_STATUS_ONLY(detail, String(branch));
    assert.match(detail, /^DEV deploy-verify line, waiver part 1 of 1 /);
  }
  const { calls, deps } = spies();
  assert.equal(runWith(body("N/A: docs only"), "/nonexistent", deps, { branch: "" }), null, "no waiver part, no head ref needed");
  assert.deepEqual(calls, { git: 0, readFile: 0, resolveRoot: 0 });
  const consumer = assertBlocked(runWith(body("N/A: docs only", "skipped per user decision: X"), makeMain({ notes }), {}, { branch: "" }), { gateName: gate.CONSUMER_GATE, problem: "head-ref-missing" });
  ACTUAL_STATUS_ONLY(consumer, "consumer");
});

test("a head ref that names no change prints the head ref and offers only the actual-status step", () => {
  const root = makeMain({ branch: "main", notes: notesFile(entryText({ records: [DEV_RECORD("X")] })) });
  for (const branch of ["release/1.2.0", "main", "feature"]) {
    const detail = assertBlocked(runWith(waivedBody("X"), root, {}, { branch }), { problem: "branch-without-change", label: branch });
    assert.ok(detail.includes(`Looked for a change name in branch ${branch}`), detail);
    ACTUAL_STATUS_ONLY(detail, branch);
  }
});

// [Scenario: openspec-flow :: A description without a waiver part passes the merge without reading records]
test("hasPerPrWaiverPart: true only for a waiver part on a live DEV or Consumer evidence line", () => {
  assert.equal(gate.hasPerPrWaiverPart(waivedBody("X")), true);
  assert.equal(gate.hasPerPrWaiverPart(body("N/A: docs only", "SKIPPED PER USER DECISION: z")), true);
  assert.equal(gate.hasPerPrWaiverPart(body("deploy failed; skipped per user decision: X (observed failure)")), true);
  for (const [label, text] of [
    ["result summary", body("deployed to DEV; login passed", "project checks passed")],
    ["N/A", body("N/A: docs only")],
    ["pending", body("pending: x")],
    ["no DEV line", body(null)],
    ["no evidence section", `## Notes\n- DEV deploy-verify: HEAD ${SHA}; skipped per user decision: X\n`],
    ["fenced", body(null).replace("## Manual", `\`\`\`\nDEV deploy-verify: HEAD ${SHA}; skipped per user decision: X\n\`\`\`\n## Manual`)],
    ["confirmation note", body("N/A: docs only", "user decision: confirmed unavailable browser")],
    ["empty string", ""],
    ["null", null],
    ["undefined", undefined],
    ["number", 42],
    ["object", {}],
  ]) {
    assert.equal(gate.hasPerPrWaiverPart(text), false, label);
  }
});

// [Scenario: openspec-flow :: A waiver on a PR whose head is in another repository blocks the merge]
test("crossRepository: true blocks a waiver as cross-repository-head without git, file or root probe, with only the actual-status step", () => {
  const root = makeMain({ branch: "chore/x", notes: notesFile(entryText({ records: [DEV_RECORD("X")] })) });
  const { calls, deps } = spies();
  const detail = assertBlocked(runWith(waivedBody("X"), root, deps, { branch: "chore/x", crossRepository: true }), { problem: "cross-repository-head" });
  assert.deepEqual(calls, { git: 0, readFile: 0, resolveRoot: 0 });
  ACTUAL_STATUS_ONLY(detail, "cross-repository");
  assert.ok(!detail.includes("notes/session-pending.md"), "no record file is named as searched");
  const consumer = assertBlocked(runWith(body("N/A: docs only", "skipped per user decision: X"), root, spies().deps, { branch: "chore/x", crossRepository: true }), { gateName: gate.CONSUMER_GATE, problem: "cross-repository-head" });
  ACTUAL_STATUS_ONLY(consumer, "consumer");
  // Without a waiver part the option is irrelevant.
  assert.equal(runWith(body("N/A: docs only"), "/nonexistent", spies().deps, { branch: "chore/x", crossRepository: true }), null);
  // The same record still lets a same-repository PR pass; only === true counts.
  for (const crossRepository of [false, undefined, "true", 1, null]) {
    assert.equal(runWith(waivedBody("X"), root, {}, { branch: "chore/x", crossRepository }), null, String(crossRepository));
  }
  assert.equal(runWith(waivedBody("X"), root, {}, { branch: "chore/x" }), null);
  // A missing head ref is reported before the cross-repository decision needs a branch.
  assertBlocked(runWith(waivedBody("X"), root, spies().deps, { branch: "", crossRepository: true }), { problem: "head-ref-missing" });
});

// [Scenario: openspec-flow :: A waiver added after the PR was opened blocks the merge without a record]
test("perPrWaiverMergeReason: the shared outer string for both merge paths, with the tool named for each", () => {
  const error = { gate: gate.DEV_GATE, detail: "DEV deploy-verify line, waiver part 1 of 1 (\"X\"): detail text." };
  const ghReason = gate.perPrWaiverMergeReason(error, "23", "gh pr edit");
  assert.equal(ghReason, `DEV deploy-verify gate: ${error.detail}\nMerge-time check of PR #23: the current PR description is compared again before merge. Retry the merge after the next step above; to replace a waiver with the actual status, edit the description with gh pr edit.`);
  const mcpReason = gate.perPrWaiverMergeReason({ gate: gate.CONSUMER_GATE, detail: error.detail }, 7, "the GitHub web page (MCP update_issue cannot edit a PR), then run github_check_pr again");
  assert.equal(mcpReason, `Consumer pre-PR checks gate: ${error.detail}\nMerge-time check of PR #7: the current PR description is compared again before merge. Retry the merge after the next step above; to replace a waiver with the actual status, edit the description with the GitHub web page (MCP update_issue cannot edit a PR), then run github_check_pr again.`);
  for (const reason of [ghReason, mcpReason]) {
    assert.ok(!reason.includes("gh pr create"), "no gh pr create recipe");
    assert.ok(!/bypass|DEVPRO_HOOK_BYPASS/i.test(reason), "no bypass hint");
    assert.ok(!reason.includes("--body-file"), "no body-file recipe");
  }
});

// [Scenario: openspec-flow :: A description edit that adds an unmatched waiver is blocked before the edit]
test("perPrWaiverEditReason: the outer string for the gh pr edit path", () => {
  const error = { gate: gate.DEV_GATE, detail: "DEV deploy-verify line, waiver part 1 of 1 (\"X\"): detail text." };
  const reason = gate.perPrWaiverEditReason(error, "23");
  assert.equal(reason, `DEV deploy-verify gate: ${error.detail}\nEdit-time check of PR #23: the new description is compared with the answer-time records before the edit. Retry the edit after the next step above.`);
  assert.ok(reason.includes("Edit-time check of PR #23"));
  assert.equal(gate.perPrWaiverEditReason({ gate: gate.CONSUMER_GATE, detail: "d" }, 7), "Consumer pre-PR checks gate: d\nEdit-time check of PR #7: the new description is compared with the answer-time records before the edit. Retry the edit after the next step above.");
  assert.ok(!reason.includes("gh pr create"), "no gh pr create recipe");
  assert.ok(!/bypass|DEVPRO_HOOK_BYPASS/i.test(reason), "no bypass hint");
});

// [Scenario: openspec-flow :: A waiver added after the PR was opened blocks the merge without a record]
test("a merge-time block carries the line kind and detail of the creation-time block for the same problem, and prints no record", () => {
  const root = makeMain({ branch: "main", notes: notesFile(entryText({ records: [DEV_RECORD("another reason ZQ")] })) });
  const created = runWith(waivedBody("X marks"), root, {}, { branch: "chore/x" });
  const detail = assertBlocked(created, { problem: "no-match" });
  const merged = gate.perPrWaiverMergeReason(created, 9, "gh pr edit");
  assert.ok(merged.startsWith(`${gate.DEV_GATE}: ${detail}`));
  assert.ok(!/ZQ/.test(merged), "the record content is not printed");
  for (const needle of ["x", "chore/x", "notes/session-pending.md", "ask the user"]) assert.ok(merged.includes(needle), needle);
});

// ---- checkoutRepoIdentity: moved verbatim out of consumerPrePrChecksState ----

function makeIdentityRepo({ kind }) {
  const root = makeMain({ branch: "chore/x" });
  if (kind === "consumer") {
    writeFileSync(path.join(root, ".gitmodules"), '[submodule "rules"]\n path = .devpro-agent-rules\n');
    mkdirSync(path.join(root, ".devpro/scripts"), { recursive: true });
    writeFileSync(path.join(root, ".devpro/scripts/sync-agent-rules.mjs"), "x");
    writeFileSync(path.join(root, ".devpro/scripts/devpro-doctor.mjs"), "x");
  }
  if (kind === "source") {
    mkdirSync(path.join(root, ".devpro/agent-rules"), { recursive: true });
    mkdirSync(path.join(root, ".devpro/scripts"), { recursive: true });
    writeFileSync(path.join(root, ".devpro/agent-rules/rule-audit-playbook.md"), "x");
    writeFileSync(path.join(root, ".devpro/scripts/pre-pr-archive-gate.mjs"), "x");
  }
  if (kind === "source" || kind === "consumer" || kind === "origin-only") {
    writeFileSync(path.join(root, ".git/config"), `[remote "origin"]\n\turl = https://example.invalid/${kind === "source" ? "devpro-agent-rules" : "other-repo"}.git\n`);
  }
  return root;
}

test("checkoutRepoIdentity: returns the top-level root and the classified identity and evidence for source, consumer and unknown", () => {
  for (const kind of ["source", "consumer", "unknown", "origin-only"]) {
    const root = makeIdentityRepo({ kind });
    const result = gate.checkoutRepoIdentity(root);
    assert.equal(result.error, undefined, kind);
    assert.equal(result.root, realpathSync(root), `${kind}: root is the git top-level`);
    assert.equal(result.identity, kind === "origin-only" ? "unknown" : kind, kind);
    assert.equal(typeof result.evidence, "string", kind);
    assert.ok(result.evidence.length > 0, kind);
  }
  const nested = makeIdentityRepo({ kind: "consumer" });
  mkdirSync(path.join(nested, "sub/dir"), { recursive: true });
  assert.equal(gate.checkoutRepoIdentity(path.join(nested, "sub/dir")).root, realpathSync(nested), "a subdirectory resolves to the top-level");
});

test("checkoutRepoIdentity: a non-git directory returns the verbatim error string and nothing else", () => {
  assert.deepEqual(gate.checkoutRepoIdentity(tempDir()), { error: "Git repository query failed; run git rev-parse --show-toplevel in the PR checkout" });
});

test("consumerPrePrChecksState keeps its results and error strings after the extraction", () => {
  assert.deepEqual(gate.consumerPrePrChecksState(tempDir()), { error: "Git repository query failed; run git rev-parse --show-toplevel in the PR checkout" });
  const source = makeIdentityRepo({ kind: "source" });
  assert.deepEqual(gate.consumerPrePrChecksState(source), { applicable: false, source: true });
  // A hand-built repository has no commit, so the HEAD tree query fails and keeps its own message.
  const consumer = makeIdentityRepo({ kind: "consumer" });
  assert.deepEqual(gate.consumerPrePrChecksState(consumer), { error: "Git HEAD checks query failed; inspect git ls-tree --name-only HEAD -- .devpro/pre-pr-checks.local.md" });
});
