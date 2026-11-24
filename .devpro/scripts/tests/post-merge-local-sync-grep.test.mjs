/**
 * post-merge-local-sync-grep.test.mjs
 *
 * Locks `### Post-merge Local Sync` rule in `git-workflow-tracking.md`:
 * after `gh pr merge` succeeds, TL must checkout merge target + pull,
 * then return to main + pull, to keep local refs fresh and avoid
 * devpro:pre-pr Pre-flight #4 stale-main cycle.
 *
 * Companion to existing handoff-cite-gate / archive-gate-grep series.
 *
 * REQUIRED locks: lifecycle vocabulary + section ordering + 3 merge-target rows
 * + Why + Exit Criteria + Rationalization.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";
import {
  BLOCKING_STATUS_PREFIXES,
  fixtureStatus,
  primaryCheckoutCompletionAllowed,
} from "./lib/submodule-status-contract.mjs";
const rulePath = repoPath(".devpro/agent-rules/git-workflow-tracking.md");
const ruleBody = readFileSync(rulePath, "utf8");

const REQUIRED = [
  // Lifecycle vocabulary: post-PR is PR-created state; post-merge is PR-merged state.
  "post-PR = PR created, not merged",
  "post-merge = PR merged",
  "Step 5.5 exemption check",
  "非豁免 PR",
  "cross-model review",
  "cross-model review before merge",
  "豁免 PR",
  // Section heading + why
  "### Post-merge Local Sync",
  "merge 完成後本地同步",
  "**必須**主動同步",
  "stale ref",
  // Per-target sequences (3 rows in table)
  "`git checkout main && git pull --ff-only`",
  "`git checkout production && git pull --ff-only --tags`",
  // hotfix carrier + back-merge coverage (enforce-hotfix-release-carrier: no
  // more dual-PR bypass; carrier promotes then back-merges to main)
  "back-merge PR merge 後",
  "Hotfix carrier → `production` + tag → back-merge PR → `main`",
  // Anchor sync follow-on (why)
  "detect-branch-base.mjs --anchor",
  "devpro:pre-pr` Pre-flight #4",
  // Local sync/status evidence expected in merge handoff.
  "sync/status",
  "git status --short --branch",
  // Terse continuation handoff guard.
  "NextAction",
  "AskFirstPending",
  "選項 1",
];

const EXIT_CRITERIA_LOCK = "Post-merge Local Sync 序列";

const RATIONALIZATION_LOCK = "merge 完成、Actions 終態回報，本地 sync 下次再說";

const LEADING_PLUS_COMPLETION_COMPOUND =
  /leading `\+`.*MUST NOT declare.*(?:\/devpro:sync-rules|sync|release).*complete/;

function assertLeadingPlusCompletionCompound(section, carrierName) {
  const compoundLine = section
    .split("\n")
    .find((line) => line.includes("leading `+`") && line.includes("MUST NOT declare"));

  assert.ok(compoundLine, `${carrierName} must keep leading + and completion prohibition on one physical line`);
  assert.match(compoundLine, LEADING_PLUS_COMPLETION_COMPOUND);
  const leadingPlusOffset = compoundLine.indexOf("leading `+`");
  const polarityMutation =
    compoundLine.slice(0, leadingPlusOffset) +
    compoundLine.slice(leadingPlusOffset).replace("MUST NOT declare", "MUST declare");
  assert.doesNotMatch(
    polarityMutation,
    LEADING_PLUS_COMPLETION_COMPOUND,
    `${carrierName} mutation without NOT must fail the polarity-sensitive guard`,
  );
}

for (const phrase of REQUIRED) {
  test(`git-workflow-tracking.md contains required Post-merge Local Sync phrase: ${phrase}`, () => {
    assert.ok(
      ruleBody.includes(phrase),
      `expected git-workflow-tracking.md to contain "${phrase}" (Post-merge Local Sync rule lock)`
    );
  });
}

test("git-workflow-tracking.md Exit Criteria references Post-merge Local Sync", () => {
  assert.ok(
    ruleBody.includes(EXIT_CRITERIA_LOCK),
    `Exit Criteria must reference Post-merge Local Sync sequence (issue: forgotten as soft-recommendation)`
  );
});

test("git-workflow-tracking.md Common Rationalizations includes 'sync 下次再說' refutation", () => {
  assert.ok(
    ruleBody.includes(RATIONALIZATION_LOCK),
    `Rationalization table must include the "merge done, sync later" anti-pattern refutation`
  );
});

test("consumer rules-lane post-merge sync aligns the primary checkout and blocks a pointer mismatch", () => {
  const section = ruleBody.match(
    /### Consumer Rules Lane Primary-Checkout Close-out[\s\S]*?(?=\n### |\n## |$)/,
  )?.[0];

  assert.ok(section, "Post-merge Local Sync must contain the consumer rules-lane primary-checkout close-out");
  assert.match(section, /git submodule update --init \.devpro-agent-rules/);
  assert.match(section, /git submodule status \.devpro-agent-rules/);
  assertLeadingPlusCompletionCompound(section, "git-workflow-tracking.md");
  assert.match(section, /MUST NOT[\s\S]*stage[\s\S]*stale SHA/);
  assert.match(section, /MUST NOT[\s\S]*--remote/);
  assert.doesNotMatch(section, /git submodule update --init --remote \.devpro-agent-rules/);
  assert.match(section, /(?:before|先於)[\s\S]*`production` branch[\s\S]*anchor[\s\S]*(?:missing|缺失)/);
});

test("primary-checkout completion predicate blocks every non-space gitlink status prefix", () => {
  assert.equal(primaryCheckoutCompletionAllowed(fixtureStatus(" ")), true);
  for (const prefix of BLOCKING_STATUS_PREFIXES) {
    assert.equal(
      primaryCheckoutCompletionAllowed(fixtureStatus(prefix)),
      false,
      `leading ${prefix} must remain a completion blocker`,
    );
  }
  assert.equal(primaryCheckoutCompletionAllowed(""), false, "missing status evidence must fail closed");

});

test("git-workflow-tracking.md Post-PR created handoff and Post-merge Local Sync are distinct ordered sections", () => {
  // Sanity: post-PR created handoff is a different lifecycle section from
  // post-merge local sync, and both appear before Exit Criteria.
  const handoffIdx = ruleBody.indexOf("### Post-PR created handoff");
  const syncIdx = ruleBody.indexOf("### Post-merge Local Sync");
  const exitIdx = ruleBody.indexOf("## Exit Criteria");
  assert.ok(handoffIdx !== -1, "Post-PR created handoff subsection missing");
  assert.ok(syncIdx !== -1, "Post-merge Local Sync subsection missing");
  assert.ok(exitIdx !== -1, "Exit Criteria heading missing");
  assert.ok(
    handoffIdx < syncIdx && syncIdx < exitIdx,
    `Post-PR created handoff must precede Post-merge Local Sync, which must precede Exit Criteria (handoff=${handoffIdx}, sync=${syncIdx}, exit=${exitIdx})`
  );
});

// A worktree-isolated session (e.g. Claude Code after EnterWorktree) can refuse
// `git -C <main-checkout-root>`; the sync obligation stays and is handed to the user.
test("Post-merge Local Sync hands the main-checkout sync to the user when the host blocks `git -C`", () => {
  const section = ruleBody.match(/### Post-merge Local Sync[\s\S]*?(?=\n### |\n## )/)?.[0];
  assert.ok(section, "Post-merge Local Sync section missing");
  const line = section.split("\n").find((l) => l.startsWith("**host 擋下 `git -C <main-checkout-root>` 時**"));
  assert.ok(line, "Post-merge Local Sync must carry the host-blocked handoff branch");
  assert.match(line, /`! git -C <main-checkout-root> pull --ff-only origin main/);
  assert.match(line, /main checkout 的 session/);
  assert.match(line, /MUST NOT 宣稱已同步/);
  assert.match(line, /stop-point-comms\.md/);

  const recap = readFileSync(repoPath(".devpro/agent-rules/session-recap.md"), "utf8");
  const lintSync = recap.split("\n").find((l) => l.startsWith("**Lint 前同步**"));
  assert.ok(lintSync, "session-recap.md Lint 前同步 missing");
  assert.match(lintSync, /host 擋下.*§Post-merge Local Sync/);

  const adapter = readFileSync(repoPath(".devpro/agent-rules/platform-adapters/claude-code.md"), "utf8");
  const risk = adapter.match(/### 風險 G：worktree 隔離 session 擋 main checkout 的 `git -C`[\s\S]*?(?=\n### |\n## )/)?.[0];
  assert.ok(risk, "claude-code.md must carry 風險 G for the isolated-session `git -C` block");
  assert.match(risk, /git-workflow-tracking\.md` §Post-merge Local Sync/);
  assert.match(risk, /\*\*禁止\*\*：宣稱已同步/);
});

// #3704 r3 F6/F7: a hub tracks another repository's workflows, so every workflow query example names that repository
// and reads the workflow list at the tracked ref (gh api without ref reads the default branch).
test("git-workflow-tracking: every gh run watch command names the repository, and the workflow list is read at the tracked ref", () => {
  const watchLines = ruleBody.split("\n").filter((line) => /^\s*gh run watch\b/.test(line));
  assert.ok(watchLines.length > 0);
  for (const line of watchLines) assert.match(line, /-R github\.com\/OWNER\/REPO/, line);
  const listReads = ruleBody.match(/gh api [^\x60]*?"?repos\/OWNER\/REPO\/contents\/\.github\/workflows[^\x60]*/g) ?? [];
  assert.ok(listReads.length > 0);
  for (const read of listReads) {
    assert.match(read, /\?ref=<commit SHA>/, read);
    // GH_HOST or an enterprise default host would read another site (#3704 r5 F7).
    assert.match(read, /^gh api --hostname github\.com /, read);
  }
  assert.match(ruleBody, /git -C <checkout> ls-tree --name-only <commit> \.github\/workflows\//);
});
