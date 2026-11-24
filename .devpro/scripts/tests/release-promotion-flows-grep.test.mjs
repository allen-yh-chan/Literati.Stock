import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import path from 'node:path';
import { readSourceFile as read } from './lib/read.mjs';



function assertUniqueLine(text, pattern, message) {
  const matches = text.split('\n').filter((line) => pattern.test(line));
  assert.equal(matches.length, 1, `${message}: expected exactly one operative line, got ${matches.length}`);
}

function sliceUniqueRequirement(text, title, carrier) {
  const heading = `### Requirement: ${title}`;
  const lines = text.split('\n');
  const starts = lines.flatMap((line, index) => line === heading ? [index] : []);
  assert.equal(starts.length, 1, `${carrier}: expected exactly one ${heading}, got ${starts.length}`);

  const start = starts[0];
  const relativeEnd = lines.slice(start + 1).findIndex((line) => /^#{1,3}[ \t]+/.test(line));
  const end = relativeEnd === -1 ? lines.length : start + 1 + relativeEnd;
  return lines.slice(start, end).join('\n');
}

const releaseFlow = read('.devpro/agent-rules/release-sit-uat-pat-prod.md');
const releaseSteps = read('.devpro/agent-rules/release-step-1-7.md');
const hotfixRecipe = read('.devpro/agent-rules/release-hotfix-carrier-lane.md');
const preflightChecklist = read('.devpro/agent-rules/preflight-checklist.md');
const openspecFlowRule = read('.devpro/agent-rules/openspec-flow.md');
const openspecSteps = read('.devpro/agent-rules/openspec-step-1-to-9.md');
const archivePrinciples = read('.devpro/agent-rules/openspec-archive-principles.md');
const branchRule = read('.devpro/agent-rules/git-branch-naming-and-anchor.md');
const ancestryRepairLeaf = read('.devpro/agent-rules/git-branch-production-ancestry-repair.md');
const branchFlowHub = read('.devpro/agent-rules/git-branch-and-pr-flow.md');
const gitPrFlow = read('.devpro/agent-rules/git-pr-template-and-merge.md');
const runbookSkill = read('.devpro/agent-skills/release/release-runbook/SKILL.md');
const openspecFlow = read('openspec/specs/openspec-flow/spec.md');
const productionBackfillDelta = read('openspec/changes/archive/2026-08-12-clarify-production-backfill-lane/specs/openspec-flow/spec.md');
const archivedDelta = read('openspec/changes/archive/2026-07-15-fix-production-ancestry/specs/openspec-flow/spec.md');
const branchGlossary = read('.devpro/agent-rules/branch-terminology-glossary.md');
const hotfixScenario = read('scenarios/scenario-d-consumer-repo-hotfix.md');
const consumerReleaseScenario = read('scenarios/scenario-f-consumer-repo-release-flow.md');
const sourceReleaseScenario = read('scenarios/scenario-h-source-repo-release-flow.md');

test('Source Release Tags Only After Production PR Merge Verification', () => {
  for (const [name, text] of [
    ['release steps', releaseSteps],
    ['release flow', releaseFlow],
    ['consumer release scenario', consumerReleaseScenario],
    ['source release scenario', sourceReleaseScenario],
  ]) {
    assert.match(text, /push[^\n]*(?:work|release)[^\n]*branch|push[^\n]*`release\//i, `${name} must push the work/release branch`);
    assert.match(text, /(?:PR|pull request)[^\n]*(?:base|→)[^\n]*`?production`?/i, `${name} must open a PR with base production`);
    assert.match(text, /GitHub[^\n]*(?:merge|合併)|(?:merge|合併)[^\n]*GitHub/i, `${name} must merge through GitHub`);
    assert.match(text, /exact[^\n]*(?:merged production|production PR merge|merge commit)/i, `${name} must resolve the exact merged production commit`);
    assert.match(text, /fresh(?:ly)?[^\n]*(?:fetch|re-fetch)[^\n]*origin\/production/i, `${name} must freshly fetch origin/production`);
    assert.match(text, /(?:tag|標籤)[^\n]*(?:explicit|明確)[^\n]*(?:commit|SHA)|(?:explicit|明確)[^\n]*(?:commit|SHA)[^\n]*(?:tag|標籤)/i, `${name} must tag the explicit merge commit`);
    assert.match(text, /push only[^\n]*tag ref|只推[^\n]*tag ref|push[^\n]*only[^\n]*refs\/tags/i, `${name} must push only the tag ref`);
    assert.doesNotMatch(text, /^\s*git push origin production --tags\s*$/m, `${name} must not combine production and tag pushes`);
    assert.doesNotMatch(text, /^\s*git push origin main production[^\n]*--tags\s*$/m, `${name} must not push protected refs with tags`);
  }

  assert.doesNotMatch(releaseSteps, /^\s*git checkout production\s*\n\s*git merge --no-ff release\//m);
  assert.doesNotMatch(sourceReleaseScenario, /^\s*- \[ \] `git checkout production && git merge --no-ff release\//m);
});

test('Tag Push Contains No Protected Branch Ref', () => {
  for (const [name, text] of [
    ['release steps', releaseSteps],
    ['release flow', releaseFlow],
    ['consumer release scenario', consumerReleaseScenario],
    ['source release scenario', sourceReleaseScenario],
  ]) {
    assert.match(text, /push only[^\n]*tag ref|只推[^\n]*tag ref|push[^\n]*only[^\n]*refs\/tags/i, `${name} must state a tag-only push`);
    assert.doesNotMatch(text, /^\s*git push origin production --tags\s*$/m, `${name} must not push production with tags`);
    assert.doesNotMatch(text, /^\s*git push origin main production[^\n]*--tags\s*$/m, `${name} must not include protected branch refs in the tag push`);
  }
});

test('generic release recipe binds the selected production PR to the pushed release head', () => {
  assert.match(releaseSteps, /RELEASE_SHA=\$\(git rev-parse "\$RELEASE_BRANCH\^\{commit\}"\)/);
  assert.match(releaseSteps, /--json state,baseRefName,headRefName,headRefOid,mergeCommit/);
  assert.match(releaseSteps, /\.headRefName[\s\S]*\$RELEASE_BRANCH/);
  assert.match(releaseSteps, /\.headRefOid[\s\S]*\$RELEASE_SHA/);
});

test('verified already-live repo backfill routes through the hotfix release-carrier lane, not a no-release bypass', () => {
  for (const [name, text] of [
    ['branch rule', branchRule],
    ['release flow', releaseFlow],
    ['branch glossary', branchGlossary],
    ['hotfix scenario', hotfixScenario],
  ]) {
    for (const phrase of [
      'already-live',
      'repo-missing backfill',
      'not-yet-live nonurgent',
    ]) {
      assert.ok(text.includes(phrase), `${name} missing production backfill boundary: ${phrase}`);
    }
  }

  for (const phrase of [
    'PR/commit/OpenSpec',
    '**最近 `production-*` tag（僅此）**',
  ]) {
    assert.ok(branchRule.includes(phrase), `branch rule missing production backfill contract: ${phrase}`);
  }
  assert.match(branchRule, /prefix 表示 promotion path\/state，非作者/);
  assertUniqueLine(
    openspecSteps,
    /緊急 PROD bug[^\n]*verified already-live repo-missing backfill[^\n]*→ `hotfix\/`[^\n]*最近 `production-\*` tag[^\n]*source／consumer 同構經 release carrier[^\n]*back-merge PR 回 main/,
    'OpenSpec Step 3 must route both urgent repairs and verified already-live backfills to hotfix',
  );
  assertUniqueLine(
    branchRule,
    /規範只承認五種前綴[^\n]*`sync\/`/,
    'branch rule must keep sync outside the closed prefix set',
  );
  assert.match(
    read('.devpro/agent-rules/release-hotfix-carrier-policy.md'),
    /already-live[^\n]*release-carrier lane[^\n]*freeze、build once、smoke、provenance[^\n]*不再有「不經 release」的雙 PR 旁路/,
    'already-live backfill must route through the release-carrier lane; no direct-without-release dual-PR bypass may remain',
  );
  assert.match(hotfixScenario, /not-yet-live nonurgent[^\n]*MUST NOT[^\n]*hotfix/);
  for (const [name, text] of [
    ['hotfix carrier policy', read('.devpro/agent-rules/release-hotfix-carrier-policy.md')],
    ['hotfix scenario', hotfixScenario],
  ]) {
    assert.match(
      text,
      /non-urgent already-live backfill[^\n]*normal OpenSpec\/pre-flight[^\n]*hotfix prefix alone MUST NOT authorize freeze-break[^\n]*at least smoke/,
      `${name} must separate bypass mechanics from urgency-only exceptions`,
    );
  }
  assertUniqueLine(
    preflightChecklist,
    /independently urgent[^\n]*lite pre-flight[^\n]*24h[^\n]*non-urgent already-live backfill[^\n]*normal checklist[^\n]*實作前/,
    'pre-flight checklist must limit the lite path to independently urgent repairs',
  );
  assertUniqueLine(
    hotfixRecipe,
    /independently urgent[^\n]*24h[^\n]*non-urgent already-live backfill[^\n]*OpenSpec\/pre-flight[^\n]*實作前/,
    'hotfix carrier recipe must limit the 24h deferral to independently urgent repairs',
  );
  for (const [name, text] of [
    ['OpenSpec flow rule', openspecFlowRule],
    ['archive principles', archivePrinciples],
    ['PR template', gitPrFlow],
  ]) {
    assertUniqueLine(
      text,
      /independently urgent[^\n]*24h[^\n]*non-urgent already-live backfill[^\n]*OpenSpec\/pre-flight[^\n]*實作前[^\n]*archive[^\n]*freeze[^\n]*PR 前/,
      `${name} must keep normal backfill archive after freeze and before PR`,
    );
  }

  const hubPrefixSection = branchFlowHub.match(
    /^### 分支前綴[ \t]*\n([\s\S]*?)(?=^#{1,3}[ \t]+|$(?![\s\S]))/m,
  )?.[1];
  assert.ok(hubPrefixSection, 'branch-flow hub missing the branch-prefix section');
  assert.match(
    hubPrefixSection,
    /規範只承認五種前綴[\s\S]*`feature\/`[\s\S]*`bugfix\/`[\s\S]*`chore\/`[\s\S]*`hotfix\/`[\s\S]*`rules\/`/,
  );
  assert.match(hubPrefixSection, /`sync\/`[\s\S]*任何其他前綴/);
  assert.match(
    hubPrefixSection,
    /git-branch-naming-and-anchor\.md[\s\S]*§分支前綴對照表（唯一權威）/,
  );
  assert.doesNotMatch(
    hubPrefixSection,
    /^\s*(?:>\s*)*\|.+\|\s*$/m,
    'branch-flow hub must remain pointer-only instead of rebuilding a routing table',
  );

  const forbiddenHubTableClaim = /hub `\.devpro\/agent-rules\/git-branch-and-pr-flow\.md` retains[^;\n]*分支前綴對照表/;
  const staleClaimFixture = 'The hub `.devpro/agent-rules/git-branch-and-pr-flow.md` retains routing index + 分支前綴對照表 + Slash command 批次同意 as routing-only contents.';
  const pointerOnlyFixture = 'The hub `.devpro/agent-rules/git-branch-and-pr-flow.md` retains the routing index + closed-prefix reminder/pointer + Slash command 批次同意 as routing-only contents; the authoritative 分支前綴對照表 lives only in `.devpro/agent-rules/git-branch-naming-and-anchor.md`.';
  assert.match(staleClaimFixture, forbiddenHubTableClaim, 'forbidden marker must catch the historical hub-owns-table claim');
  assert.doesNotMatch(pointerOnlyFixture, forbiddenHubTableClaim, 'forbidden marker must allow the pointer-only replacement');

  // enforce-hotfix-release-carrier (D10) rewrote the canonical MODIFIED scenario:
  // the already-live backfill now reconciles production/main by cutting a release
  // carrier (not a standalone "bypass"), so canonical says "the carrier lane MUST
  // retain at least smoke verification" where the archived pre-carrier delta still
  // says "the bypass MUST retain at least smoke verification" — archived text is
  // historical and MUST NOT be edited to match.
  for (const [name, spec, smokeFloorPattern] of [
    ['canonical openspec-flow', openspecFlow, /the carrier lane MUST retain at least smoke verification/],
    ['archived production-backfill delta', productionBackfillDelta, /bypass MUST retain at least smoke verification/],
  ]) {
    const requirement = sliceUniqueRequirement(spec, 'Branch Routing Decision', name);
    assertUniqueLine(
      requirement,
      /hub `\.devpro\/agent-rules\/git-branch-and-pr-flow\.md` retains[^\n]*closed-prefix reminder\/pointer[^\n]*authoritative 分支前綴對照表 lives only in `\.devpro\/agent-rules\/git-branch-naming-and-anchor\.md`/,
      `${name} must keep the hub pointer and naming-leaf ownership on one operative line`,
    );
    assertUniqueLine(
      requirement,
      /THEN[^\n]*SHALL load the hub[^\n]*closed-prefix boundary[^\n]*SHALL follow its pointer[^\n]*authoritative prefix decision table/,
      `${name} must direct readers from the hub to the authoritative table`,
    );
    assertUniqueLine(
      requirement,
      /when the backfill is not independently urgent[^\n]*MUST complete normal OpenSpec and pre-flight[^\n]*MUST NOT treat the `hotfix\/\*` prefix alone as freeze-break authorization/,
      `${name} must separate the bypass lane from urgency-only process exceptions`,
    );
    assertUniqueLine(
      requirement,
      smokeFloorPattern,
      `${name} must retain the smoke verification floor`,
    );
    assert.doesNotMatch(
      requirement,
      forbiddenHubTableClaim,
      `${name} must not claim the pointer-only hub owns the authoritative table`,
    );
  }
  assert.match(
    sliceUniqueRequirement(openspecFlow, 'Branch Routing Decision', 'canonical openspec-flow'),
    /cutting a release carrier from that tag[^\n]*freezing it, building once, and merging it into `production` via its own pull request per `Hotfix Reaches Production Only Through A Frozen Release Carrier`/,
    'canonical openspec-flow must route the already-live backfill through the frozen release-carrier lane, not a standalone dual-PR bypass',
  );
});

test('release entry leaf defines release intents and optional DEV confidence gate', () => {
  for (const phrase of [
    'optional `integration` / DEV confidence gate',
    '`confidence-gate skip`',
    'Release intent / entry path',
    '`release-to-sit`',
    '`release-to-production-new`',
    '`release-to-production-existing`',
    'Subset selection handoff',
    'candidate subset list',
  ]) {
    assert.ok(releaseFlow.includes(phrase), `release entry leaf missing ${phrase}`);
  }
});

test('step recipe makes subset selection user-selectable before new release assembly', () => {
  for (const phrase of [
    'Release intent + subset handoff + optional DEV confidence gate',
    '候選可促進單位清單',
    '交由使用者/TL 選擇',
    'approved subset',
    '未批准項目不得進 `release/*`',
    'DEV full validation 是 optional confidence gate',
    '`confidence-gate skip`',
  ]) {
    assert.ok(releaseSteps.includes(phrase), `release steps missing ${phrase}`);
  }
});

test('production promotion supports new assembly and existing release artifact paths', () => {
  for (const phrase of [
    '`release-to-production-new`',
    '`release-to-production-existing`',
    'existing-release checklist',
    'branch HEAD SHA',
    'artifact id/build metadata',
    'approval/provenance',
    '無新增未驗 commit',
    '不得重挑 subset 或 rebuild',
  ]) {
    assert.ok(releaseSteps.includes(phrase), `release steps missing production path phrase: ${phrase}`);
  }
});

test('source SemVer release requires explicit subset or full-main approval', () => {
  for (const [name, text] of [
    ['release flow', releaseFlow],
    ['release steps', releaseSteps],
    ['runbook skill', runbookSkill],
    ['openspec-flow spec', openspecFlow],
  ]) {
    for (const phrase of [
      'Source SemVer Release Requires Explicit Subset Selection',
      'approved subset = `full-main`',
      'selected `main` HEAD SHA',
      '`release/v<X.Y.Z>`',
    ]) {
      assert.ok(text.includes(phrase), `${name} missing source SemVer subset phrase: ${phrase}`);
    }
  }
  assert.doesNotMatch(
    releaseFlow,
    /release\/v<X\.Y\.Z>[^。\n]*git merge --no-ff main/,
    'source SemVer release must not document implicit `git merge --no-ff main` assembly',
  );
});

test('every tagged ordinary promotion requires exact-tag completion without changing assembly selection', () => {
  // Applicability stays in the Step 6A section of release-step-1-7.md; the commands and routing live in its on-demand leaf.
  const completionText = `${releaseSteps}\n${read('.devpro/agent-rules/release-back-merge-completion.md')}`;
  assertUniqueLine(
    releaseSteps,
    /MUST 套用[^\n]*exact `production-\*` tag[^\n]*finite subset[^\n]*`full-main`[^\n]*non-subset[^\n]*new\/existing/,
    'ordinary completion must cover every promotion shape once an exact production tag exists',
  );
  assertUniqueLine(
    releaseSteps,
    /只改 completion topology[^\n]*不改[^\n]*assembly selection/,
    'universal completion must not change release assembly selection',
  );
  assertUniqueLine(
    releaseSteps,
    /SIT-only[^\n]*no tag[^\n]*first-import no-tag[^\n]*N\/A/,
    'paths without a promoted tag must remain outside completion reconciliation',
  );
  assertUniqueLine(
    completionText,
    /recommendedRoute=release-lane-back-merge[^\n]*`git merge --ff-only "\$PROMOTED_PRODUCTION_TAG"`[^\n]*PR 回 `main`[^\n]*regular\/no-ff/,
    'ordinary graph-only reconciliation must back-merge through the same release branch into main',
  );
  assertUniqueLine(
    completionText,
    /ff-only 失敗[^\n]*`content-review-required`[^\n]*→ 轉 `git-branch-production-ancestry-repair\.md`/,
    'non-back-merge shapes must route to the dedicated repair lane',
  );
  assertUniqueLine(
    completionText,
    /MUST NOT[^\n]*squash[^\n]*rebase[^\n]*`-s ours`[^\n]*patch-equivalence/,
    'ordinary reconciliation must reject parent-erasing substitutes',
  );
  assertUniqueLine(
    completionText,
    /`graph-only`[^\n]*MUST[^\n]*conflict-free[^\n]*resulting merge tree[^\n]*candidate main tree[^\n]*merge parent[^\n]*zero tree delta/,
    'ordinary graph-only reconciliation must bind both safety predicates and merge evidence',
  );
  assertUniqueLine(
    completionText,
    /`content-review-required`[^\n]*MUST[^\n]*content review[^\n]*tests/,
    'content-bearing ordinary reconciliation must retain review and tests',
  );
  assertUniqueLine(
    completionText,
    /re-fetch `origin\/main`[^\n]*重新取得 `CANDIDATE_MAIN_SHA`[^\n]*exit 0[^\n]*complete/,
    'ordinary release completion must wait for the post-merge exact-ref gate',
  );
  assertUniqueLine(
    completionText,
    /只有 ancestry gate 非 0[^\n]*`--reconciliation-status`[^\n]*divergence classifier[^\n]*分類完成前不得宣告或建立 Production ancestry repair \/ bounded repair/,
    'ordinary post-gate failure must classify before repair',
  );
  assertUniqueLine(
    completionText,
    /classification=main-ancestor-confirmed[^\n]*recommendedRoute=no-op[^\n]*MUST 視為 no-op complete[^\n]*MUST NOT 宣告 `graph-only`/,
    'ordinary already-ancestor status must stay no-op instead of graph-only or repair',
  );
  assertUniqueLine(
    ancestryRepairLeaf,
    /ancestry gate 非 0[^\n]*reconciliation classification trigger[^\n]*不得立即宣告或建立 Production ancestry repair \/ bounded repair/,
    'ancestry repair leaf must not classify exact-tag gate failure as bounded repair',
  );
  assert.ok(
    openspecFlow.includes('Ancestry Gate Failure Requires Reconciliation Classification Before Repair'),
    'openspec-flow must specify classification before repair',
  );
  assert.match(
    completionText,
    /node \.devpro\/scripts\/detect-branch-base\.mjs --require-main-ancestor --production-ref "\$PROMOTED_PRODUCTION_TAG" --main-ref "\$CANDIDATE_MAIN_SHA"/,
  );
  assert.match(completionText, /own-change-only three-dot/);
});

test('hotfix forwards the exact tag through the same branch before regular main merge', () => {
  for (const pattern of [
    /git merge --ff-only "\$PROMOTED_PRODUCTION_TAG"/,
    /HEAD[^\n]*exact promoted tag/,
    /PR #2[^\n]*regular[^\n]*no-ff/,
    /squash[^\n]*rebase[^\n]*patch replay/,
    /re-fetch[^\n]*--require-main-ancestor[^\n]*exit 0[^\n]*complete/,
    /stale-H[^\n]*generic[^\n]*exact-tag repair/,
  ]) {
    assert.match(hotfixRecipe, pattern, `hotfix carrier recipe missing exact-tag-forward contract: ${pattern}`);
  }
  assert.match(
    gitPrFlow,
    /same branch[^\n]*advanced[^\n]*exact PR #1 tag[^\n]*before PR #2/,
    'PR routing must advance the same branch to the exact PR #1 tag before PR #2',
  );
  assert.match(
    gitPrFlow,
    /完整 mechanics[^\n]*release-hotfix-carrier-lane\.md[^\n]*Grandfathered legacy hotfix completion/,
    'PR routing must delegate full hotfix mechanics to the canonical hotfix carrier recipe',
  );
});

test('release runbook and OpenSpec expose universal completion enforcement without installing CI', () => {
  for (const phrase of [
    'rules / ordinary promotion',
    'exact promoted tag',
    'candidate main SHA',
    'all tagged promotion shapes',
    're-fetch `origin/main`',
    'portable server required check',
  ]) {
    assert.ok(runbookSkill.includes(phrase), `runbook skill missing ancestry phrase: ${phrase}`);
  }
  assert.match(
    runbookSkill,
    /node \.devpro\/scripts\/detect-branch-base\.mjs --require-main-ancestor --production-ref "\$PROMOTED_PRODUCTION_TAG" --main-ref "\$CANDIDATE_MAIN_SHA"/,
  );
  assertUniqueLine(
    runbookSkill,
    /本 change MUST NOT[^\n]*workflow[^\n]*ruleset[^\n]*branch protection/,
    'portable server check must not silently install repository enforcement',
  );

  for (const [name, text] of [
    ['canonical spec', openspecFlow],
    ['archived delta', archivedDelta],
  ]) {
    for (const phrase of [
      'Universal Tagged Production Ancestry Reconciliation And Completion',
      'finite subset, full-main, non-subset, new assembly, or existing release',
      'Hotfix Exact Tag Forward Preserves Production Lineage',
      'SIT-only, no-tag, and first-import no-tag',
    ]) {
      assert.ok(text.includes(phrase), `${name} missing universal completion phrase: ${phrase}`);
    }
  }
});

test('runbook skill routes to release intents and structured subset verification', () => {
  for (const phrase of [
    'optional DEV confidence gate',
    'release intent',
    '`release-to-sit`',
    '`release-to-production-new`',
    '`release-to-production-existing`',
    'existing release promotion',
    'structured approved-subset evidence',
    'full-main',
  ]) {
    assert.ok(runbookSkill.includes(phrase), `runbook skill missing ${phrase}`);
  }
  assert.equal(
    runbookSkill.includes('git log release/<YYYYMMDD>-<shortSHA> --not main'),
    false,
    'runbook skill must not use topology false-positive `git log release --not main` verification',
  );
  assert.equal(
    runbookSkill.includes('git diff main...release/<YYYYMMDD>-<shortSHA> --stat   # expect empty'),
    false,
    'runbook skill must not present three-dot current-main equality as the primary finite-subset verification',
  );
});

test('openspec-flow spec covers optional gate, SIT terminal, production-new, and production-existing scenarios', () => {
  for (const phrase of [
    'Scenario: Optional Dev Integration Is Confidence Gate',
    'Scenario: SIT Terminal Release Uses Release Artifact',
    'Scenario: Production New Assembly Mirrors SIT Path',
    'Scenario: Production Existing Release Verifies Provenance',
    'Requirement: Source SemVer Release Requires Explicit Subset Selection',
    'confidence-gate skip',
    'MUST NOT reselect subset or rebuild',
  ]) {
    assert.ok(openspecFlow.includes(phrase), `openspec-flow spec missing ${phrase}`);
  }
});


test('consumer release branch date is planned go-live date (not branch-creation clock)', () => {
  assert.match(
    releaseFlow,
    /release\/<YYYYMMDD>-<shortSHA>\[-<n>\][^\n]*`<YYYYMMDD>`＝預定上線日/,
    'release role table must define <YYYYMMDD> as planned go-live date',
  );

  const step2Start = releaseSteps.indexOf('**Step 2：');
  const step2End = releaseSteps.indexOf('**Step 2 補充');
  assert.ok(step2Start >= 0 && step2End > step2Start, 'Step 2 section bounds missing');
  const step2 = releaseSteps.slice(step2Start, step2End);
  assert.match(step2, /DATE=<預定上線日 YYYYMMDD>/, 'Step 2 recipe must take operator-supplied go-live date');
  assert.equal(step2.includes('date +%Y%m%d'), false, 'Step 2 block must not derive DATE from system clock');
  assert.match(step2, /環境不進分支名/, 'Step 2 must forbid encoding environment in branch name');
  assert.match(step2, /同一預定上線日/, 'Step 2 ordinal -<n> must bind to same planned go-live date, not cut day');

  assert.match(releaseSteps, /改期不改名/, 'Step 6 must state reschedule keeps planned branch name by default');
  assert.match(releaseSteps, /Rename Before Ordinal Tag/, 'Step 6 must require rename before ordinal production tag');

  const deltaPath = 'openspec/changes/amend-release-branch-date-go-live/specs/openspec-flow/spec.md';
  const archived = openspecFlow.includes('### Requirement: Consumer Release Branch Date Is Planned Go-Live Date');
  const activeDelta = (() => {
    try {
      return read(deltaPath).includes('### Requirement: Consumer Release Branch Date Is Planned Go-Live Date');
    } catch {
      return false;
    }
  })();
  assert.ok(
    archived || activeDelta,
    'openspec-flow ADDED requirement must exist in active change delta or promoted canonical spec',
  );
});


test('parallel runbook routes original assembly and effects to their operative evidence leaves', () => {
  const obligations = [
    /MUST 先讀[^\n]*release-sit-uat-pat-prod\.md[^\n]*in-scope ordinary parallel handling[^\n]*release-step-1-7\.md[^\n]*original early-SIT assembly/,
    /production merge、tag、deploy[^\n]*MUST 執行[^\n]*verification leaf[^\n]*pre-effect control[^\n]*N-drift[^\n]*缺[^\n]*停下/,
  ];
  for (const pattern of obligations) {
    assertUniqueLine(runbookSkill, pattern, 'runbook must route the scoped action before acting');
    const mutated = runbookSkill.split('\n').filter(line => !pattern.test(line)).join('\n');
    assert.throws(() => assertUniqueLine(mutated, pattern, 'removed runbook obligation'), /expected exactly one operative line, got 0/);
  }
  assert.match(releaseSteps, /in-scope ordinary parallel handling MUST 先完成[^\n]*release-verification-commands\.md[^\n]*每個 merge、tag push、deployment[^\n]*缺[^\n]*不得執行/);
});
