/**
 * release-milestone-branch-consistency-grep.test.mjs
 *
 * RED-phase grep guard for strengthen-release-milestone-branch-consistency
 * (design.md D13). Written before tasks T4-T11 touch any rule/skill/hook
 * carrier, so most (a)/(b)/(d) assertions below are EXPECTED TO FAIL until
 * those tasks land; (c) is expected to pass already because T1 already wrote
 * the spec deltas (and, per design D12, synced the MODIFIED canonical
 * bodies directly).
 *
 * Anchor strength: `rule-anchor-guard-strength.md`. Positive anchors below
 * quote design.md D1-D12 literals verbatim wherever design.md gives a
 * literal command/state-name/quoted-phrase; command-shaped anchors are
 * bound to fenced code blocks, not prose.
 *
 * F-1-08 row -> carrier -> anchor map (brd.md success-criteria table rows
 * 1-15 + design.md D12 supplement rows 16/17/18a/18b/18c). Whoever
 * implements T4-T11 MUST make the rule/skill prose contain the literal(s)
 * named here (or a superset that still contains them):
 *
 *   1    release-step-1-7.md Step 1   "Restore branch" + "AI MUST NOT 自行重建"
 *   1b   release-step-1-7.md Step 1   "PROD 前" + "PROD 後依 Step 6 清理"
 *   2    release-step-1-7.md Step 1   "isCrossRepository" + "停下交 TL"
 *   3    release-step-1-7.md Step 1   "同名多段 lineage"
 *   4    release-sit-uat-pat-prod.md §Subset selection handoff "unassigned"
 *          + release-milestone-assignment.md fenced `gh pr edit "$N" --milestone "$MS"`
 *   5    pre-pr/SKILL.md Step 4    "PR 建立前停下" + "conflict"
 *   6    release-sit-uat-pat-prod.md §Subset selection handoff "兩個以上"
 *   7    release-step-1-7.md Step 1   fenced `git merge-base --is-ancestor`
 *   8a   release-unselected-commit-handling.md Step 1 補充 (AI 處理路徑)  fenced `--force-with-lease`
 *   8b   release-unselected-commit-handling.md Step 1 補充  "MUST NOT 再對原分支 force push"
 *   8c   release-step-1-7.md Step 2   "核准失效" + "重跑 Step 1"
 *   9    release-step-1-7.md Step 2   "此處 SHA 屬整體快照" + "首次 release"
 *   10   release-step-1-7.md Step 2   "此處 SHA 屬整體快照" + "full-main"
 *   11   release-step-1-7.md Step 2   "superset" + "只標最早目標輪" (unchanged; expected already green)
 *   12   release-step-1-7.md Step 1   "MUST NOT 進 subset" + "改走"
 *   13   pre-pr/SKILL.md Step 4    fenced `gh pr create` + `--milestone`
 *   14   release-step-1-7.md Step 1   "MUST NOT 帶日期或" + "--search"
 *   15   release-hotfix-carrier-lane.md §Hotfix release-carrier lane（source／consumer 同構）
 *          fenced `gh pr merge <n> --repo github.com/OWNER/REPO --merge` (PR-based; enforce-hotfix-release-carrier
 *          superseded the local `git merge --no-ff "origin/hotfix/<name>"` recipe)
 *   16   release-step-1-7.md Step 1   "尚未合入 `main`"
 *   17   release-step-1-7.md Step 1   "跨舊截止日的同名重用也會被擋"
 *   18a  release-unselected-commit-handling.md Step 1 補充  "MUST NOT 帶著 `conflict` 開新 PR"
 *   18b  release-unselected-commit-handling.md Step 1 補充  "新 PR 不帶 milestone"
 *   18c  release-unselected-commit-handling.md Step 1 補充  fenced `gh pr create` + `--milestone`
 *
 * (d) pre-tool-gate.mjs new block-reason wording: "approved branches" +
 *     "git merge --no-ff origin/<branch>" (design D11 pre-tool-gate.mjs row).
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readSourceFile as read, readRepoFileIfExists } from './lib/read.mjs';

const releaseFlow = read('.devpro/agent-rules/release-sit-uat-pat-prod.md');
const milestoneAssignment = read('.devpro/agent-rules/release-milestone-assignment.md');
const releaseSteps = read('.devpro/agent-rules/release-step-1-7.md');
const dpPrePr = read('.devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md');
const runbookSkill = read('.devpro/agent-skills/release/release-runbook/SKILL.md');
const preToolGate = read('.devpro/scripts/hooks/pre-tool-gate.mjs');
const readmeFile = read('README.md');
const scenarioH = read('scenarios/scenario-h-source-repo-release-flow.md');

function sliceBetween(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  assert.ok(start >= 0, `missing start marker: ${startMarker}`);
  const from = start + startMarker.length;
  const end = endMarker ? text.indexOf(endMarker, from) : -1;
  return end >= 0 ? text.slice(start, end) : text.slice(start);
}

/**
 * Extract every fenced ```...``` code-block body from `text`. Command-shaped
 * anchors MUST be bound to one of these, not to surrounding prose (per
 * rule-anchor-guard-strength.md §錨點作用域守則 — the prose also names the
 * flag/command in plain words, so a prose-level includes() would stay green
 * even if the executable snippet lost it).
 */
function extractFencedBlocks(text) {
  const blocks = [];
  const re = /```[^\n]*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text))) {
    blocks.push(m[1]);
  }
  return blocks;
}

function assertLiteralInFence(text, literal, label) {
  const blocks = extractFencedBlocks(text);
  const hit = blocks.some((b) => b.includes(literal));
  assert.ok(hit, `${label}: expected a fenced code block containing literal: ${literal}`);
}

function countOccurrences(text, needle) {
  if (!needle) return 0;
  return text.split(needle).length - 1;
}

// ---------------------------------------------------------------------------
// Section slices (rule leaves not yet touched by T4-T11; Step 1 補充 does not
// exist yet on release-step-1-7.md, so its sliceBetween is EXPECTED TO THROW
// until T8 lands — that failure is itself the RED signal for rows 8a/8b/12/
// 18a/18b/18c).
// ---------------------------------------------------------------------------

function step1Slice() {
  return sliceBetween(releaseSteps, '**Step 1：', '**Step 2：');
}

function step2Slice() {
  return sliceBetween(releaseSteps, '**Step 2：', '**Step 3：');
}

function step1SuppSlice() {
  const leaf = read('.devpro/agent-rules/release-unselected-commit-handling.md');
  const start = leaf.indexOf('**Step 1 補充：分支上有本輪不上線的 commit（AI 處理路徑）**');
  assert.ok(start >= 0, 'Step 1 補充 heading must exist in release-unselected-commit-handling.md');
  const next = leaf.indexOf('\n## ', start);
  return next === -1 ? leaf.slice(start) : leaf.slice(start, next);
}

function hotfixStepSlice() {
  return sliceBetween(
    read('.devpro/agent-rules/release-hotfix-carrier-lane.md'),
    '### Hotfix release-carrier lane（source／consumer 同構）',
    '### Grandfathered legacy hotfix completion',
  );
}

function ssotSlice() {
  return sliceBetween(releaseFlow, '**Subset selection handoff', '### Anchor 判斷規則');
}

// The directly executable assignment block lives in the on-demand leaf; the slice
// ends at the failure-handling paragraph so later additions are not misread.
function assignmentSlice() {
  return sliceBetween(milestoneAssignment, '**Branch-Level Milestone Assignment With Read-Back', '任一步失敗');
}

function prePrStep4Slice() {
  return sliceBetween(dpPrePr, '### Step 4: PR Description', '### Step 5: Post-PR Workflow Watch');
}

// ---------------------------------------------------------------------------
// (a) F-1-08 rows 1-15 + supplement rows 16/17/18a/18b/18c — one test per row
// ---------------------------------------------------------------------------

test('F-1-08 row 1: deleted branch before PROD stops for Restore, AI does not recreate', () => {
  const step1 = step1Slice();
  assert.ok(step1.includes('Restore branch'), 'Step 1 must reference the GitHub "Restore branch" action');
  assert.ok(step1.includes('AI MUST NOT 自行重建'), 'Step 1 must forbid the AI from recreating the branch itself');
});

test('rule-feedback #3568: explicit authorization restores the deleted branch at the last MERGED same-repo PR headRefOid', () => {
  const step1 = step1Slice();
  assertLiteralInFence(step1, 'gh api -X POST "repos/{owner}/{repo}/git/refs"', 'Step 1 第 4 項 authorized restore');
  assertLiteralInFence(step1, 'refs/heads/$BRANCH', 'Step 1 第 4 項 authorized restore ref');
  assertLiteralInFence(
    step1,
    'gh api "repos/{owner}/{repo}/git/ref/heads/$BRANCH"',
    'Step 1 第 4 項 must refuse an existing remote ref by exact endpoint, not a branch-tail pattern',
  );
  assert.ok(step1.includes('$LASTEXITCODE'), 'the PowerShell equivalent MUST branch on the exit code, not on stdout');
  assert.ok(
    !extractFencedBlocks(step1).some((block) => block.includes('if (gh api')),
    'no runnable block may use if (gh api ...): a 404 still writes to stdout and reads as truthy',
  );
  assert.ok(step1.includes('isCrossRepository=false'), 'restore source MUST be a same-repo PR');
  assert.ok(
    step1.includes('MUST NOT 用本機分支／工作區狀態'),
    'restore MUST NOT use a local branch or working-tree state',
  );
  assert.ok(step1.includes('重跑整個健全檢查'), 'restore MUST re-run the whole branch health check');
});

test('F-1-08 row 1b: branch cleaned up after PROD is not flagged for Restore', () => {
  const step1 = step1Slice();
  assert.ok(step1.includes('PROD 前'), 'Step 1 must distinguish PROD-前 deletion');
  assert.ok(step1.includes('PROD 後依 Step 6 清理'), 'Step 1 must state PROD-後 Step 6 cleanup is a different case');
});

test('F-1-08 row 2: fork PR stops Step 1 for the branch', () => {
  const step1 = step1Slice();
  assert.ok(step1.includes('isCrossRepository'), 'Step 1 must check isCrossRepository for fork detection');
  assert.ok(step1.includes('停下交 TL'), 'Step 1 must route fork PRs to the tech lead');
});

test('F-1-08 row 3: reused branch name with multiple lineages stops Step 1', () => {
  const step1 = step1Slice();
  assert.ok(step1.includes('同名多段 lineage'), 'Step 1 must detect multi-lineage name reuse');
});

test('F-rmbc-pr2-02: regular-merge check covers every merged PR, not only the unit merge commit', () => {
  const step1 = step1Slice();
  assertLiteralInFence(step1, '"$PMC^2"', 'Step 1 健全檢查（每筆 merged PR 的 regular merge）');
});

test('F-1-08 row 4: all-unassigned branch requires TL assignment via read-back procedure', () => {
  const ssot = ssotSlice();
  assert.ok(ssot.includes('unassigned'), 'SSOT section must name the unassigned branch state');
  assert.ok(
    ssot.includes('`release-milestone-assignment.md`'),
    'SSOT section must point at the leaf that holds the assignment commands',
  );
  assertLiteralInFence(assignmentSlice(), 'gh pr edit "$N" --milestone "$MS"', 'release-milestone-assignment.md');
});

test('F-1-08 row 5: conflict branch stops PR creation before any write', () => {
  const step4 = prePrStep4Slice();
  assert.ok(step4.includes('PR 建立前停下'), 'devpro:pre-pr Step 4 must stop before gh pr create on conflict');
  assert.ok(step4.includes('conflict'), 'devpro:pre-pr Step 4 must name the conflict state');
});

test('F-1-08 row 6: two distinct milestones yield conflict state', () => {
  const ssot = ssotSlice();
  assert.ok(ssot.includes('兩個以上'), 'SSOT section must define conflict as two-or-more distinct milestone values');
});

test('F-1-08 row 7: anchor-predating merge is still listed as a candidate (ancestry, not date)', () => {
  const step1 = step1Slice();
  assertLiteralInFence(step1, 'git merge-base --is-ancestor', 'Step 1 candidate query');
});

test('F-1-08 row 8a: force-with-lease rejection halts the relocation rewrite', () => {
  const supp = step1SuppSlice();
  assertLiteralInFence(supp, '--force-with-lease', 'Step 1 補充 (AI 處理路徑)');
});

test('F-1-08 row 8b: push-succeeds-but-readback-mismatch forbids further force-push', () => {
  const supp = step1SuppSlice();
  assert.ok(
    supp.includes('MUST NOT 再對原分支 force push'),
    'Step 1 補充 must forbid re-force-pushing the original branch after a mismatched read-back',
  );
});

test('F-1-08 row 8c: approval invalidates when Step 1-to-2 snapshot no longer matches', () => {
  const step2 = step2Slice();
  assert.ok(step2.includes('核准失效'), 'Step 2 must state a mismatched snapshot invalidates the approval');
  assert.ok(step2.includes('重跑 Step 1'), 'Step 2 must require re-running Step 1 for an invalidated branch');
});

test('F-1-08 row 9: first release still records a whole-main snapshot, not a per-branch merge target', () => {
  const step2 = step2Slice();
  assert.ok(step2.includes('此處 SHA 屬整體快照'), 'Step 2 must state the SHA is whole-snapshot evidence, not a unit merge target');
  assert.ok(step2.includes('首次 release'), 'Step 2 must anchor this statement to the first-release case');
});

test('F-1-08 row 10: explicit full-main assembly still records the selected main HEAD SHA as a whole snapshot', () => {
  const step2 = step2Slice();
  assert.ok(step2.includes('此處 SHA 屬整體快照'), 'Step 2 must state the SHA is whole-snapshot evidence, not a unit merge target');
  assert.ok(step2.includes('full-main'), 'Step 2 must anchor this statement to the full-main case');
});

test('F-1-08 row 11: parallel-round superset ordering is unchanged', () => {
  const step2 = step2Slice();
  assert.ok(step2.includes('superset'), 'Step 2 must still state the superset ordering rule');
  assert.ok(step2.includes('只標最早目標輪'), 'Step 2 must still state a unit is only labelled with its earliest target round');
});

test('F-1-08 row 12: tip mismatch routes to the relocation path instead of entering the subset', () => {
  const step1 = step1Slice();
  assert.ok(step1.includes('MUST NOT 進 subset'), 'Step 1 must forbid a tip-mismatched branch from entering the subset');
  assert.ok(step1.includes('改走'), 'Step 1 must route a tip-mismatched branch elsewhere (Step 1 補充)');
});

test('F-1-08 row 13: follow-up PR inherits the single existing branch milestone', () => {
  const step4 = prePrStep4Slice();
  assertLiteralInFence(step4, 'gh pr create', 'devpro:pre-pr Step 4');
  assertLiteralInFence(step4, '--milestone', 'devpro:pre-pr Step 4');
});

test('F-1-08 row 14: query result at the limit boundary is rejected as incomplete', () => {
  const step1 = step1Slice();
  assert.ok(step1.includes('MUST NOT 帶日期或'), 'Step 1 candidate query must forbid date narrowing');
  assert.ok(step1.includes('--search'), 'Step 1 candidate query must forbid --search narrowing');
});

test('F-1-08 row 15: hotfix release-carrier lane merges each re-verified hotfix PR into the carrier via GitHub, not a local no-ff merge', () => {
  const hotfix = hotfixStepSlice();
  assertLiteralInFence(hotfix, 'gh pr merge <n> --repo github.com/OWNER/REPO --merge', '§Hotfix release-carrier lane');
  assertLiteralInFence(
    hotfix,
    'hotfix-carrier-verify.mjs pre-merge --pr <n>',
    '§Hotfix release-carrier lane',
  );
  assert.doesNotMatch(
    hotfix,
    /git merge --no-ff "origin\/hotfix\/<name>"/,
    'the unified carrier lane must not authorize a local --no-ff merge of origin/hotfix/<name> (superseded by PR-based merge + pre-merge/merge-proof)',
  );
});

test('F-1-08 supplement row 16: open-only branch is not a release candidate', () => {
  const step1 = step1Slice();
  assert.ok(step1.includes('尚未合入 `main`'), 'Step 1 must annotate open-only branches as not yet merged into main');
});

test('F-1-08 supplement row 17: branch name reused across an old merge date is still detected', () => {
  const step1 = step1Slice();
  assert.ok(
    step1.includes('跨舊截止日的同名重用也會被擋'),
    'Step 1 must state that cross-old-cutoff name reuse is still caught by the complete result set',
  );
});

test('F-1-08 supplement row 18a: relocation stops before any write when the branch is conflict', () => {
  const supp = step1SuppSlice();
  assert.ok(
    supp.includes('MUST NOT 帶著 `conflict` 開新 PR'),
    'Step 1 補充 must forbid opening the relocated PR while the branch is conflict',
  );
});

test('F-1-08 supplement row 18b: relocated PR on an unassigned branch carries no milestone', () => {
  const supp = step1SuppSlice();
  assert.ok(supp.includes('新 PR 不帶 milestone'), 'Step 1 補充 must state the relocated PR carries no milestone when unassigned');
});

test('F-1-08 supplement row 18c: relocated PR inherits the single branch milestone', () => {
  const supp = step1SuppSlice();
  assertLiteralInFence(supp, 'gh pr create', 'Step 1 補充');
  assertLiteralInFence(supp, '--milestone', 'Step 1 補充');
});

// ---------------------------------------------------------------------------
// (b) Negative anchors: D11 "改" carriers MUST NOT contain the superseded
// wording. Scope excludes openspec/changes/ (change artifacts and this test
// file's own negative-assertion literals are expected to name the old
// wording) per D11's own re-scan command.
// ---------------------------------------------------------------------------

const NEGATIVE_CARRIERS = {
  'release-sit-uat-pat-prod.md': releaseFlow,
  'release-step-1-7.md': releaseSteps,
  'release-runbook/SKILL.md': runbookSkill,
  'pre-tool-gate.mjs': preToolGate,
  'README.md': readmeFile,
  'scenario-h-source-repo-release-flow.md': scenarioH,
  'scenario-f-consumer-repo-release-flow.md': read('scenarios/scenario-f-consumer-repo-release-flow.md'),
  'scenario-p-consumer-repo-uat-bugfix.md': read('scenarios/scenario-p-consumer-repo-uat-bugfix.md'),
  'canonical openspec-flow/spec.md': read('openspec/specs/openspec-flow/spec.md'),
  'canonical pre-tool-mechanical-gates/spec.md': read('openspec/specs/pre-tool-mechanical-gates/spec.md'),
  'canonical source-hotfix-semver-assemble/spec.md': read('openspec/specs/source-hotfix-semver-assemble/spec.md'),
};

const FORBIDDEN_LITERALS = [
  'merge only approved refs/SHAs',
  '<approved-ref-or-sha>',
  'merged:>=',
  'PR 作者於建立 PR 時掛',
  "bounded to the round's anchor",
  'merge **only** the approved tip SHAs',
  'milestone:<YYYYMMDD>',
  '--search "milestone:',
  "--search 'milestone:",
];

// scenario-f / scenario-p walkthrough steps MUST merge the freshly re-verified
// `origin/<branch>`, never a local branch ref (F-rmbc-pr1-05).
test('scenario-f and scenario-p never merge a local promotable-branch ref', () => {
  const localBranchMerge = /git merge (?:--no-ff )?(?:"|`)?(?:feature|bugfix|chore)\//;
  for (const name of ['scenario-f-consumer-repo-release-flow.md', 'scenario-p-consumer-repo-uat-bugfix.md']) {
    const text = NEGATIVE_CARRIERS[name];
    assert.ok(
      !localBranchMerge.test(text),
      `${name} must not merge a local promotable-branch ref (git merge <local-branch>); merge target must be origin/<branch>`,
    );
  }
});

for (const literal of FORBIDDEN_LITERALS) {
  test(`D11 negative anchor is absent from every "改" carrier: ${literal}`, () => {
    for (const [name, text] of Object.entries(NEGATIVE_CARRIERS)) {
      const count = countOccurrences(text, literal);
      assert.equal(count, 0, `${name} still contains superseded literal "${literal}" (${count} occurrence(s))`);
    }
  });
}

// ---------------------------------------------------------------------------
// (c) Every ADDED / MODIFIED-new `#### Scenario:` title, asserted against the
// active delta (pre-archive) or canonical spec (post-archive), per the
// release-milestone-bucket-grep SPEC_CARRIERS pattern.
// ---------------------------------------------------------------------------

const SPEC_CARRIERS = [
  'openspec/specs/openspec-flow/spec.md',
  'openspec/specs/pre-tool-mechanical-gates/spec.md',
  'openspec/specs/source-hotfix-semver-assemble/spec.md',
  'openspec/changes/strengthen-release-milestone-branch-consistency/specs/openspec-flow/spec.md',
  'openspec/changes/strengthen-release-milestone-branch-consistency/specs/pre-tool-mechanical-gates/spec.md',
  'openspec/changes/strengthen-release-milestone-branch-consistency/specs/source-hotfix-semver-assemble/spec.md',
]
  .map(readRepoFileIfExists)
  .filter(Boolean)
  .join('\n');

// 8 ADDED requirements (openspec-flow) — asserted for completeness alongside
// the scenario titles below (already GREEN: T1 already committed the delta).
const ADDED_REQUIREMENTS = [
  'Branch Milestone Consistency State',
  'PR Creation Inherits Branch Milestone',
  'Branch-Level Milestone Assignment With Read-Back',
  'Release Candidate Branch Health Check',
  'Approved Branch Snapshot And Whole-Branch Assembly',
  'Promotable Branch Name Reuse And Fork PR Restriction',
  'Same-Branch Partial Release Is Not Supported',
  'Unreleased Branch Commit Relocation Path',
];

// Every #### Scenario: title newly introduced by this change — 26 under the
// 8 ADDED requirements above, plus 3 new scenarios added inside otherwise-
// MODIFIED requirements (2 in openspec-flow's `Release Candidate Query By
// Milestone`, 1 in source-hotfix-semver-assemble's `Source Hotfix Reaches
// Production Only Via SemVer Assemble`). Computed by diffing base commit
// 7a0a67e263e40265e0c0b03ecd2a5b082b4fc5ac's canonical `#### Scenario:`
// titles against this change's delta titles (comm -13, per capability).
const NEW_SCENARIOS = [
  // Branch Milestone Consistency State
  'All PRs unassigned yields unassigned state',
  'Partially assigned PRs yield conflict state',
  'Two distinct milestones yield conflict state',
  // PR Creation Inherits Branch Milestone
  'Single branch milestone is inherited by the new PR',
  'No existing PRs or all unassigned creates PR without prompting',
  'Conflict state blocks PR creation before any write',
  // Branch-Level Milestone Assignment With Read-Back
  'Batch milestone write succeeds after read-back confirms every PR',
  'Partial write failure is reported incomplete, not silently accepted',
  'Unit tip already inside a cut release branch triggers a recut reminder',
  // Release Candidate Branch Health Check
  'Deleted branch before PROD stops for Restore',
  'Branch cleaned up after PROD is not flagged for Restore',
  'Non-regular merge fails closed',
  'Tip mismatch routes to the relocation path',
  // Approved Branch Snapshot And Whole-Branch Assembly
  'Approval invalidates when the snapshot no longer matches before merge',
  'Post-merge read-back mismatch stops before push',
  'First release still uses a whole-main snapshot',
  'Explicit full-main assembly still uses the selected main HEAD SHA',
  // Promotable Branch Name Reuse And Fork PR Restriction
  'Fork PR stops Step 1 for the branch',
  'Reused branch name with multiple lineages stops Step 1 for the branch',
  'Branch name reused across an old merge date is still detected',
  // Same-Branch Partial Release Is Not Supported
  'Branch with commits already on main can only be rescheduled whole',
  'New work targeting a different round on an already-merged branch is only reminded, not blocked',
  // Unreleased Branch Commit Relocation Path
  'Lease rejected during relocation halts the rewrite',
  'Push succeeds but read-back mismatch forbids further force-push',
  'Relocation stops before any write when the branch milestone is conflict',
  'Relocated PR on an unassigned branch carries no milestone',
  'Relocated PR inherits the single branch milestone',
  // MODIFIED Release Candidate Query By Milestone (new scenarios only)
  'Query result at the limit boundary is rejected as incomplete',
  'Open-only branch is not a release candidate',
  'Squash-merged released unit is not listed as a candidate',
  // MODIFIED Source Hotfix Reaches Production Only Via SemVer Assemble (new scenario only)
  'Stale hotfix tip or invalidated sticky forces re-approval before merge',
];

test('spec deltas define every ADDED requirement introduced by this change', () => {
  for (const title of ADDED_REQUIREMENTS) {
    assert.ok(
      SPEC_CARRIERS.includes(`### Requirement: ${title}`),
      `spec carriers missing ADDED requirement: ${title}`,
    );
  }
});

for (const title of NEW_SCENARIOS) {
  test(`spec carriers assert new scenario literally: ${title}`, () => {
    assert.ok(
      SPEC_CARRIERS.includes(`#### Scenario: ${title}`),
      `spec carriers missing scenario: ${title}`,
    );
  });
}

test('F-1-08 row 11 carrier: Parallel Release Rounds Superset Ordering scenario still exists', () => {
  assert.ok(
    SPEC_CARRIERS.includes('### Requirement: Parallel Release Rounds Superset Ordering'),
    'canonical spec must still define Parallel Release Rounds Superset Ordering (unchanged by this change)',
  );
  assert.ok(
    SPEC_CARRIERS.includes('#### Scenario: Later round is a superset of the previous round'),
    'canonical spec must still carry its scenario (unchanged by this change)',
  );
});

// ---------------------------------------------------------------------------
// (d) pre-tool-gate.mjs new block-reason wording (design D11 pre-tool-gate.mjs
// row: message/comment wording only, judgment logic unchanged).
// ---------------------------------------------------------------------------

test('pre-tool-gate.mjs block reason uses "approved branches" wording, not "approved refs/SHAs"', () => {
  assert.ok(
    preToolGate.includes('approved branches'),
    'pre-tool-gate.mjs must carry the new "approved branches" block-reason wording',
  );
});

test('pre-tool-gate.mjs suggested recovery command merges the verified origin branch, not a ref/SHA', () => {
  assertLiteralInFence(preToolGate, 'git merge --no-ff origin/<branch>', 'pre-tool-gate.mjs suggested recovery block');
});
