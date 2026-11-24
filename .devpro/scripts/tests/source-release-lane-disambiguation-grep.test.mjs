import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readSourceFile as read } from './lib/read.mjs';



const releaseFlow = read('.devpro/agent-rules/release-sit-uat-pat-prod.md');
const rulesLane = read('.devpro/agent-rules/release-rules-lane.md');
const releaseSteps = read('.devpro/agent-rules/release-step-1-7.md');
const rulesFlow = read('.devpro/agent-rules/rules-flow.md');
const agentsMd = read('AGENTS.md');
const canonicalSpec = read('openspec/specs/rules-flow/spec.md');

test('source repo SemVer release lane is explicit', () => {
  for (const phrase of [
    'source repo 用 SemVer 軌',
    'release/v<X.Y.Z>',
    'production-v<X.Y.Z>',
    'chore/bump-v<X.Y.Z>',
    'Source SemVer Release Requires Explicit Subset Selection',
  ]) {
    assert.ok(releaseFlow.includes(phrase), `release flow missing ${phrase}`);
  }
});

test('source repo SemVer lane does not imply whole-main release assembly', () => {
  for (const phrase of [
    'approved subset = `full-main`',
    'selected `main` HEAD SHA',
    '不得推論整個 `main`',
    '只能 merge 已核准分支（approved branches；核准快照，見上）剛驗證的 `origin/<branch>`',
  ]) {
    assert.ok(releaseFlow.includes(phrase), `release flow missing source subset guard phrase: ${phrase}`);
  }
  assert.ok(!releaseFlow.includes('merge only approved refs/SHAs'), 'source subset guard must merge verified branches, not approved refs/SHAs');
  assert.doesNotMatch(
    releaseFlow,
    /Source repo：`release\/v<X\.Y\.Z>`[^。\n]*`git merge --no-ff main`/,
    'source SemVer assembled test gate must not say release/v implicitly merges main',
  );
  assert.doesNotMatch(
    releaseFlow,
    /release 必須保留「previous production tag → explicit merge main」/,
    'source SemVer skeleton must not require explicit merge main for every release/v',
  );
});

test('source repo production advances by PR and semver tag targets its exact merge commit', () => {
  for (const phrase of [
    'Push `release/v$VERSION`，建立 base=`production` 的 PR',
    'resolve 該 PR 的 exact merged production commit 為 `MERGE_SHA`',
    'git tag production-v$VERSION "$MERGE_SHA"',
    'git push origin refs/tags/production-v$VERSION',
    '禁 local production merge',
  ]) {
    assert.ok(releaseFlow.includes(phrase), `release flow missing production PR/exact-tag phrase: ${phrase}`);
  }
});

test('consumer rules sync lane is separate from source repo release', () => {
  // Strings that stayed in the entry leaf:
  for (const phrase of [
    'consumer rules sync 才用 Rules Lane',
    'production-YYYYMMDD-rules',
  ]) {
    assert.ok(releaseFlow.includes(phrase), `release flow missing ${phrase}`);
  }
  // Strings that moved to release-rules-lane.md (T4 de-bundle):
  for (const phrase of [
    'release/rules-<YYYYMMDD>',
    'rules/` 分支只適用 consumer repo',
    '不得因「rules repo / rules change」字樣誤用 `release/rules-*`',
  ]) {
    assert.ok(rulesLane.includes(phrase), `release-rules-lane.md missing ${phrase}`);
  }
});

test('consumer rules release requires submodule alignment and exact refs confirmation', () => {
  // All these strings moved to release-rules-lane.md (T4 de-bundle):
  for (const phrase of [
    'git submodule update --init .devpro-agent-rules',
    'node .devpro-agent-rules/.devpro/scripts/sync-agent-rules.mjs --sync',
    'node .devpro/scripts/sync-agent-rules.mjs --check',
    'Production promotion 前必須列出 exact refs 與 PR identity',
    'release/rules-... -> <sha>',
    'production PR head/base',
    'exact production PR merge commit -> <sha>',
    'production-...-rules tag -> <same sha>',
  ]) {
    assert.ok(rulesLane.includes(phrase), `release-rules-lane.md missing ${phrase}`);
  }
});

test('consumer rules release cherry-picks sync commits instead of merging rules branch', () => {
  // These strings moved to release-rules-lane.md (T4 de-bundle):
  assert.ok(
    rulesLane.includes('git cherry-pick <sync-commit-sha>'),
    'release-rules-lane.md must cherry-pick the exact sync commit into release/rules',
  );
  assert.equal(
    rulesLane.includes('git merge rules/<source>-v<X.Y.Z>'),
    false,
    'release-rules-lane.md must not merge the whole rules branch into release/rules',
  );
  assert.ok(
    rulesLane.includes('只帶本批 sync commit'),
    'release-rules-lane.md must preserve sync-commit-only invariant',
  );
});

test('universal tagged ancestry completion does not change lane assembly', () => {
  assert.match(rulesLane, /git cherry-pick <sync-commit-sha>/);
  assert.doesNotMatch(rulesLane, /git merge rules\/<source>-v<X\.Y\.Z>/);
  assert.match(
    releaseSteps,
    /MUST 套用[^\n]*finite subset[^\n]*`full-main`[^\n]*non-subset[^\n]*new\/existing/,
    'ordinary completion must cover all promotion shapes after tag creation',
  );
  assert.match(
    releaseSteps,
    /只改 completion topology[^\n]*不改[^\n]*assembly selection/,
    'universal completion must preserve source subset/full-main assembly selection',
  );
});

test('rules release merge gate documents no-openspec fallback evidence', () => {
  // These strings moved to release-rules-lane.md (T4 de-bundle):
  for (const phrase of [
    'No items found to validate.',
    'dp-reviewer',
    'read-only readiness verdict mode',
    'PR number',
    'head SHA',
    'validation evidence/log path',
    'not cross-model sticky',
    'devpro:second-review',
    'second-reviewer',
    '不得混用 exemption',
    'SubagentAuthPending',
    'capture-command.mjs --topic openspec',
    'verdict',
    'Totals:',
  ]) {
    assert.ok(rulesLane.includes(phrase), `release-rules-lane.md missing merge-gate fallback phrase: ${phrase}`);
  }
});

test('consumer rules release requires prune dry-run before completion', () => {
  for (const [name, text, phrase] of [
    // Strings that moved to release-rules-lane.md (T4 de-bundle):
    ['release-rules-lane.md', rulesLane, 'Rules Lane 對 Step 6 § 分支清理之加強要求'],
    ['release-rules-lane.md', rulesLane, '`production-YYYYMMDD-rules[-n]` tag pushed 後'],
    ['release-rules-lane.md', rulesLane, '未回報前不得宣告 Rules Lane release 完成'],
    ['release-rules-lane.md', rulesLane, '此要求只授權 dry-run'],
    // Strings that stayed in the entry leaf (Exit Criteria section):
    ['release flow', releaseFlow, 'node .devpro/scripts/prune-merged-local.mjs'],
    ['release flow', releaseFlow, '候選分支 / worktree / orphaned 摘要'],
    ['canonical spec', canonicalSpec, 'Rules Lane Post-Tag Prune Dry-Run'],
    ['canonical spec', canonicalSpec, 'MUST NOT authorize `--exec`'],
  ]) {
    assert.ok(text.includes(phrase), `${name} missing ${phrase}`);
  }
});

test('rules-flow owns lane details and AGENTS routes to canonical leaves', () => {
  assert.ok(
    rulesFlow.includes('source repo release 禁用 `release/rules-*`'),
    'rules-flow must forbid release/rules for source repo release',
  );
  assert.ok(
    rulesFlow.includes('只走 `release/v<X.Y.Z>` → `production-v<X.Y.Z>`'),
    'rules-flow must name the source repo SemVer lane',
  );
  assert.ok(
    agentsMd.includes('source repo SemVer release → `release-sit-uat-pat-prod.md`'),
    'AGENTS.md must route source repo release to the release leaf',
  );
  assert.ok(
    agentsMd.includes('consumer sync → `rules-flow-routing.md` + `rules-flow.md`'),
    'AGENTS.md must route consumer sync to the rules-flow leaves',
  );
  assert.ok(
    agentsMd.includes('consumer production rules lane / PR DIRTY recovery → `release-rules-lane.md`'),
    'AGENTS.md must route rules production/recovery details to release-rules-lane.md',
  );
  assert.ok(
    agentsMd.includes('禁在 AGENTS.md 複寫 branch/base/cherry-pick 細則'),
    'AGENTS.md must explicitly keep branch/base/cherry-pick details out of the entry file',
  );
  assert.equal(
    agentsMd.includes('source release：`release/vX.Y.Z` → `production-vX.Y.Z`'),
    false,
    'AGENTS.md must not freeze source release branch recipes',
  );
  assert.equal(
    agentsMd.includes('production 另從 production tag 建 release/rules 並只帶同一 sync commit'),
    false,
    'AGENTS.md must not freeze production rules release recipes',
  );
});

test('legacy ambiguous routing phrases stay retired', () => {
  for (const [name, text, phrase] of [
    ['AGENTS.md', agentsMd, '同步規範 / rules lane release'],
    ['agents-md-maintenance/rules-flow', rulesFlow, 'rules lane 規範同步流程'],
    ['rules-flow classification', rulesFlow, '**分類**：rules lane 走'],
    ['rules-flow rollback', rulesFlow, '當 rules lane release 上線後'],
  ]) {
    assert.equal(text.includes(phrase), false, `${name} must not contain legacy ambiguous phrase: ${phrase}`);
  }
});

test('canonical rules-flow spec preserves both lane shapes', () => {
  for (const phrase of [
    'consumer rules lane release flow',
    'release/rules-<date>',
    'release/rules-<YYYYMMDD>',
    'production-YYYYMMDD-rules',
    'release/v<X.Y.Z>',
    'production-v<X.Y.Z>',
    'PreToolUse Gate 2h',
  ]) {
    assert.ok(canonicalSpec.includes(phrase), `canonical rules-flow spec missing ${phrase}`);
  }
});


test('source subset bump cannot import unselected main ancestry', () => {
  const paragraph = releaseFlow.split('\n').find(line => line.startsWith('**Source SemVer Release Requires Explicit Subset Selection**'));
  assert.match(paragraph, /bump-v[^\n]*同一[^\n]*production-v[^\n]*tag[^\n]*不得[^\n]*current `main`/);
  assert.match(paragraph, /full-main[^\n]*selected `main` HEAD SHA/);
  assert.doesNotMatch(releaseFlow, /bump PR 可從 current `main` 開（非 hotfix-subset/);
  const sourceSpec = read('openspec/specs/openspec-flow/spec.md');
  const rows = sourceSpec.split('\n').filter(line => line.startsWith('- **AND** for source repo SemVer subset releases the bump branch'));
  assert.equal(rows.length, 1);
  assert.match(rows[0], /SHALL start from the same[^\n]*production-v[^\n]*unselected `main` ancestry[^\n]*full-main[^\n]*selected `main` HEAD SHA[^\n]*hotfix-subset[^\n]*always/);
});
