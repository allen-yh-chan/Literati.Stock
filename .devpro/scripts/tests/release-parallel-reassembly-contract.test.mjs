// Text guards prove operative contract presence/removal resistance, not domain safety.
// One isolated Git object graph proves mechanics; it never operates consumer/live refs.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, readdirSync, lstatSync, readlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { repoPath } from './lib/repo-root.mjs';

const paths = {
  flow: '.devpro/agent-rules/release-sit-uat-pat-prod.md',
  steps: '.devpro/agent-rules/release-step-1-7.md',
  verify: '.devpro/agent-rules/release-verification-commands.md',
  qa: '.devpro/agent-rules/testing-and-qa.md',
  invariant: 'openspec/specs/openspec-flow/spec.md',
  glossary: '.devpro/agent-rules/branch-terminology-glossary.md',
};
function subsetInvariant(content) {
  content = content.replace(/\r\n/g, '\n');
  const matches = [...content.matchAll(/^### Requirement: Release Subset Of Main Invariant$/gm)];
  assert.equal(matches.length, 1, 'subset invariant authority must exist exactly once');
  const start = matches[0].index;
  const end = content.indexOf('\n### Requirement: ', start + matches[0][0].length);
  return content.slice(start, end < 0 ? content.length : end);
}
const sources = Object.fromEntries(Object.entries(paths).map(([key, file]) => [key, readFileSync(repoPath(file), 'utf8').replace(/\r\n/g, '\n')]));
sources.invariant = subsetInvariant(sources.invariant);
const guards = {
  symbols: ['flow', /^Symbols：[^\n]*K=create baseline[^\n]*P=latest finalized production[^\n]*Q=fresh production tip[^\n]*R0\/R1[^\n]*Tpreview[^\n]*R\/T[^\n]*M[^\n]*N/m],
  successors: ['flow', /^Excluded sources：[^\n]*first-release[^\n]*full-main[^\n]*Approved Branch Snapshot And Whole-Branch Assembly[^\n]*Rules Lane Release Cherry-Picks Sync Commits Only[^\n]*Hotfix Reaches Production Only Through A Frozen Release Carrier[^\n]*tag[^\n]*main/m],
  scope: ['flow', /^範圍：\*\*in-scope ordinary parallel handling\*\*[^\n]*原 early-SIT[^\n]*resulting promotion[^\n]*首次[^\n]*單輪[^\n]*full-main[^\n]*rules[^\n]*hotfix/m],
  finalized: ['flow', /^Finalized：[^\n]*MUST[^\n]*peeled[^\n]*production PR[^\n]*reachability[^\n]*部署[^\n]*Step 6A[^\n]*provenance/m],
  candidate: ['flow', /^Latest：[^\n]*MUST[^\n]*completed lane\/round order[^\n]*candidate[^\n]*MUST 停止/m],
  permission: ['flow', /^Authority：[^\n]*MUST NOT[^\n]*design[^\n]*subset[^\n]*SIT[^\n]*early SIT[^\n]*update[^\n]*QA[^\n]*自批/m],
  provisional: ['steps', /^- \*\*Early SIT\*\*：[^\n]*MAY[^\n]*then-latest[^\n]*pending predecessor[^\n]*SIT-only[^\n]*MUST NOT[^\n]*UAT\/PAT\/PROD/m],
  replanning: ['steps', /^- \*\*Predecessor 撤回\*\*：[^\n]*MUST 停止[^\n]*planning\/subset[^\n]*SIT-only[^\n]*不得[^\n]*另一前輪/m],
  choice: ['steps', /^- \*\*前輪完成\*\*：[^\n]*MUST[^\n]*conditional production-tag update[^\n]*latest-tag reassembly[^\n]*missing evidence[^\n]*clean merge[^\n]*不授予/m],
  closure: ['steps', /^- \*\*原組裝 closure\*\*：[^\n]*MUST[^\n]*create\/effective[^\n]*HEAD\/tree[^\n]*artifact\/build[^\n]*snapshot[^\n]*merge 順序[^\n]*不得補寫/m],
  snapshots: ['steps', /^- \*\*Unchanged snapshots\*\*：[^\n]*MUST[^\n]*tip OID[^\n]*PR 集合[^\n]*milestone[^\n]*health[^\n]*origin\/main[^\n]*拒絕[^\n]*Step 1[^\n]*latest-tag reassembly/m],
  represented: ['steps', /^- \*\*Scope representation\*\*：[^\n]*MUST[^\n]*原核准單位[^\n]*baseline[^\n]*tip[^\n]*內容[^\n]*不得[^\n]*milestone[^\n]*已發佈分支/m],
  parents: ['steps', /^- \*\*Pinned assembly\*\*：[^\n]*MUST[^\n]*前一步[^\n]*核准 tip[^\n]*actual parents\/tree[^\n]*same pinned parents[^\n]*conflict-free[^\n]*merge execution context/m],
  context: ['steps', /^- \*\*Replay context\*\*：[^\n]*MUST[^\n]*Git version[^\n]*strategy\/options[^\n]*rename[^\n]*attributes\/driver[^\n]*none[^\n]*非決定性[^\n]*停止/m],
  unauthorized: ['steps', /^> \*\*不變式\*\*：ordinary finite-subset 的非 production baseline 可部署內容 MUST 來自核准 whole-branch units（已 regular-merge main）與核准 lane bump；lawful assembly merge OID 不在 main 不是違規，但 MUST NOT 引入未核准 release-only patch／revert／conflict-resolution tree。single-round 及所有 scope 外 ordinary finite-subset 沿既有 structured proof／snapshot／immediate read-back 拓樸例外，不新增 parallel context 停點；first／full-main／rules／hotfix 保留各自來源契約。$/m],
  subsetScope: ['invariant', /^Only these additional parallel parent\/tree\/context proof and stop obligations[^\n]*in-scope ordinary parallel handling[^\n]*including single-round[^\n]*retain the existing structured-proof topology exception without acquiring a new parallel merge-context prerequisite[^\n]*First-release[^\n]*full-main[^\n]*Rules-lane[^\n]*Hotfix-carrier[^\n]*MUST NOT require a hotfix unit to enter main before its carrier[^\n]*No path gains permission to resolve conflicts directly on release/m],
  invariantPointer: ['glossary', /^ordinary finite-subset 的 `release ⊆ main`[^\n]*`\.devpro\/agent-rules\/release-step-1-7\.md` §Step 2 補充：merge 衝突處理原則「不變式」；MUST 讀取該 rule owner[^\n]*不另持規範正文。$/m],
  singleRoundReject: ['invariant', /^- \*\*THEN\*\* the executor MUST reject the release despite clean merge or an assembly label,[^\n]*stop before promotion[^\n]*regular PR-to-main[^\n]*fresh Step 1 approval[^\n]*topology exception grants no content exception or new parallel merge-context prerequisite$/m],
  content: ['verify', /^- \*\*Content\/domain\*\*：[^\n]*MUST[^\n]*K→P[^\n]*P→candidate[^\n]*deletion[^\n]*rename[^\n]*binary[^\n]*migration[^\n]*config[^\n]*功能 owner[^\n]*ancestry[^\n]*MUST NOT/m],
  removal: ['verify', /^- \*\*替換\/移除\*\*：[^\n]*MUST[^\n]*核准單位[^\n]*functional owner[^\n]*release approver[^\n]*release-only[^\n]*MUST NOT[^\n]*revert/m],
  bump: ['steps', /^- \*\*Metadata conflict\*\*：[^\n]*同 K[^\n]*不同版本[^\n]*不可達[^\n]*MUST[^\n]*latest-tag reassembly[^\n]*不得[^\n]*取較大[^\n]*bump-only/m],
  readback: ['steps', /^- \*\*Update execution\*\*：[^\n]*MUST[^\n]*immutable[^\n]*peeled OID[^\n]*immediate read-back[^\n]*parents[^\n]*Tpreview[^\n]*no-op[^\n]*不 push[^\n]*不 build[^\n]*不 promote/m],
  fallback: ['steps', /^- \*\*Latest-tag reassembly\*\*：[^\n]*MUST[^\n]*Anchor Sync[^\n]*regular PR[^\n]*main[^\n]*Step 1[^\n]*fresh snapshot[^\n]*origin\/<branch>[^\n]*hotfix[^\n]*優先/m],
  naming: ['steps', /^- \*\*Carrier\/version\*\*：[^\n]*MUST[^\n]*新 carrier[^\n]*Ask First[^\n]*MUST NOT[^\n]*force-push[^\n]*reset[^\n]*delete[^\n]*shortSHA[^\n]*create-anchor/m],
  artifact: ['steps', /^- \*\*版本效力\*\*：[^\n]*HEAD[^\n]*tree[^\n]*MUST[^\n]*historical[^\n]*新 Build once[^\n]*full assembled validation[^\n]*stage[^\n]*不得直接複製/m],
  noop: ['steps', /^- \*\*No-op reuse\*\*：[^\n]*HEAD\/tree[^\n]*digest[^\n]*build configuration[^\n]*dependencies[^\n]*environment[^\n]*provenance[^\n]*MAY[^\n]*content[^\n]*freshness[^\n]*QA/m],
  fresh: ['verify', /^- \*\*Fresh selection\*\*：[^\n]*MUST[^\n]*前輪完成[^\n]*組裝前[^\n]*UAT\/PAT[^\n]*production PR merge 前[^\n]*Q=P[^\n]*未閉合[^\n]*停止/m],
  preview: ['verify', /^- \*\*Promotion candidate\*\*：[^\n]*MUST[^\n]*Q\/R\/P\/T[^\n]*artifact[^\n]*Q[^\n]*R ancestry[^\n]*preview tree=T[^\n]*不得 merge[^\n]*不得臨時 build/m],
  controls: ['verify', /^- \*\*Pre-effect control\*\*：[^\n]*MUST[^\n]*same Q\/R[^\n]*tree\/artifact[^\n]*merge[^\n]*tag[^\n]*deploy[^\n]*atomic expected state[^\n]*final fetch[^\n]*head-only[^\n]*postdetect[^\n]*不合格[^\n]*latest-tag reassembly[^\n]*不得 merge\/deploy/m],
  own: ['verify', /^- \*\*Own merge transition\*\*：[^\n]*MUST[^\n]*同一 MERGED[^\n]*base=production[^\n]*head[^\n]*R[^\n]*M[^\n]*parents=Q\/R[^\n]*tree=T[^\n]*source R\/T[^\n]*舊 P\/Q/m],
  drift: ['verify', /^- \*\*Remaining effects\*\*：[^\n]*MUST[^\n]*expected M[^\n]*N[^\n]*停止[^\n]*tag\/deployment[^\n]*partial M\/N[^\n]*reachable[^\n]*不得[^\n]*不追溯/m],
  seam: ['verify', /^- \*\*Lane seam\*\*：[^\n]*source SemVer[^\n]*consumer date[^\n]*MUST[^\n]*exact M[^\n]*tree=T[^\n]*main[^\n]*ancestry[^\n]*MUST NOT[^\n]*artifact tree[^\n]*whole-main/m],
  qa: ['qa', /^- \*\*Parallel impact\*\*：[^\n]*MUST[^\n]*R0\/artifact→R1\/artifact[^\n]*K→P[^\n]*P→candidate[^\n]*functional[^\n]*shared-module[^\n]*DB[^\n]*config[^\n]*API[^\n]*Web\/API[^\n]*build\/environment[^\n]*non-overlap[^\n]*不足/m],
  reuse: ['qa', /^- \*\*Parallel QA authority\*\*：[^\n]*MUST[^\n]*rerun\/rebind[^\n]*HEAD\/artifact[^\n]*digest[^\n]*未覆蓋[^\n]*authority[^\n]*批准[^\n]*MUST NOT[^\n]*required stages[^\n]*full validation/m],
  incomplete: ['steps', /^- \*\*Evidence checkpoint\*\*：[^\n]*MUST[^\n]*持久化[^\n]*incomplete[^\n]*last successful version[^\n]*owner\/next action[^\n]*MUST NOT[^\n]*部分成功[^\n]*下一階段/m],
  material: ['qa', /^- \*\*Review material\*\*：[^\n]*MUST[^\n]*authorized necessary[^\n]*credentials[^\n]*PII[^\n]*unrelated repositories[^\n]*不得[^\n]*authority/m],
};
function protectedLine(key, source = sources) {
  const [carrier, pattern] = guards[key];
  const matches = source[carrier].split('\n').filter(line => pattern.test(line));
  assert.equal(matches.length, 1, `${key}: missing or duplicated operative ${paths[carrier]} clause`);
  return matches[0];
}
function canonicalProvenanceLine(content = sources.invariant) {
  const pattern = /^For ordinary finite-subset releases,[^\n]*approved content provenance[^\n]*MUST come from approved whole-branch units regular-merged into main[^\n]*lawful release-local assembly merge MUST NOT be rejected solely[^\n]*topology clarification MUST NOT authorize unapproved release-only content/m;
  const matches = content.replace(/\r\n/g, '\n').split('\n').filter(line => pattern.test(line));
  assert.equal(matches.length, 1, 'canonical provenance: missing or duplicated operative clause');
  return matches[0];
}

test('Assembly Merge Is A Provenance Exception', () => {
  assert.ok(canonicalProvenanceLine());
  assert.ok(protectedLine('unauthorized'));
  assert.ok(protectedLine('parents'));
});

test('Release-Only Content Rejects Reassembly', () => {
  assert.ok(protectedLine('unauthorized'));
  assert.ok(protectedLine('closure'));
});

test('Single-Round Lawful Assembly Keeps Existing Topology Exception', () => {
  assert.ok(protectedLine('unauthorized'));
  assert.ok(protectedLine('subsetScope'));
  assert.ok(protectedLine('scope'));
});

test('Single-Round Release-Only Content Is Rejected', () => {
  assert.ok(protectedLine('unauthorized'));
  assert.ok(protectedLine('subsetScope'));
  assert.ok(protectedLine('singleRoundReject'));
  assert.match(sources.invariant, /^- \*\*WHEN\*\* a non-conflicting handwritten patch or revert introduces unapproved release-only content[^\n]*approved lane bump metadata$/m);
});

test('named evidence symbols and excluded-lane source owners are discoverable', () => {
  assert.ok(protectedLine('symbols'));
  assert.ok(protectedLine('successors'));
  for (const carrier of [sources.steps, sources.verify, sources.qa,
    readFileSync(repoPath('.devpro/agent-rules/branch-terminology-glossary.md'), 'utf8'),
    readFileSync(repoPath('.devpro/agent-skills/release/release-runbook/SKILL.md'), 'utf8')]) {
    assert.match(carrier, /release-sit-uat-pat-prod\.md[^\n]*Parallel release evidence symbols/);
  }
  assert.doesNotMatch(sources.steps, /scratch A oracle|A 也記|A 不自動/);
  assert.doesNotMatch(sources.verify, /（A）/);
});

test('Original Parallel Early-SIT Assembly Needs In-Scope Proof', () => {
  assert.ok(protectedLine('parents'));
  assert.ok(protectedLine('context'));
  assert.ok(protectedLine('closure'));
});

test('Tag Finalizes After Early SIT', () => {
  assert.ok(protectedLine('choice'));
  assert.ok(protectedLine('finalized'));
});

test('Changed Unit Requires Fresh Approval', () => {
  assert.ok(protectedLine('fallback'));
  assert.ok(protectedLine('snapshots'));
});

test('Hotfix Reopen Takes Precedence Over Conditional Production-Tag Update', () => {
  assert.ok(protectedLine('fallback'));
});

test('Ancestry Does Not Prove Content Preservation', () => {
  assert.ok(protectedLine('content'));
});

test('Approved Removal Is Attributable To A Unit', () => {
  assert.ok(protectedLine('removal'));
});

test('Missing Assembly Evidence Requires Reassembly Or Stop', () => {
  assert.ok(protectedLine('closure'));
});

test('Existing SemVer Release May Use Conditional Production-Tag Update', () => {
  assert.ok(protectedLine('permission'));
  assert.ok(protectedLine('readback'));
});

test('Fallback Does Not Rewrite Existing SemVer Carrier', () => {
  assert.ok(protectedLine('naming'));
});

test('Source Backmerge Is Not Artifact Tree Proof', () => {
  assert.ok(protectedLine('seam'));
});

test('Reassembly Invalidates Old Artifact', () => {
  assert.ok(protectedLine('artifact'));
});

test('No-Op Update May Retain Verified Artifact', () => {
  assert.ok(protectedLine('noop'));
});

test('Own Merge Advances The Expected Production Tip', () => {
  assert.ok(protectedLine('own'));
});

test('Other Round Drift Blocks Remaining Effects', () => {
  assert.ok(protectedLine('drift'));
});

test('Promotion Refuses Missing Race Or Tree Evidence', () => {
  assert.ok(protectedLine('preview'));
  assert.ok(protectedLine('controls'));
  assert.ok(protectedLine('own'));
});

test('Impact Reuse Requires Authorized Scope', () => {
  assert.ok(protectedLine('qa'));
  assert.ok(protectedLine('reuse'));
});

test('Reassembly Evidence Failure Blocks Next Stage', () => {
  assert.ok(protectedLine('incomplete'));
});

test('Unapproved Reassembly Review Material Is Excluded', () => {
  assert.ok(protectedLine('material'));
});

test('Early SIT Is Provisional', () => {
  assert.ok(protectedLine('provisional'));
});

test('Finalized Previous Round Requires Conditional Update Or Latest-Tag Reassembly', () => {
  assert.ok(protectedLine('choice'));
  assert.ok(protectedLine('fresh'));
});

test('Missing Early SIT Permission Is Refused', () => {
  assert.ok(protectedLine('permission'));
  assert.ok(protectedLine('provisional'));
});

test('Missing Update Permission Is Refused', () => {
  assert.ok(protectedLine('permission'));
});

test('Unauthorized QA Reduction Is Refused', () => {
  assert.ok(protectedLine('permission'));
  assert.ok(protectedLine('reuse'));
});

test('Withdrawn Predecessor Requires Replanning', () => {
  assert.ok(protectedLine('replanning'));
});

test('Same Baseline Bump Conflict Requires Reassembly', () => {
  assert.ok(protectedLine('bump'));
});

test('Excluded Release Paths Keep Existing Contracts', () => {
  assert.ok(protectedLine('scope'));
  assert.ok(protectedLine('unauthorized'));
});

test('Tag Presence Without Completion Does Not Finalize Baseline', () => {
  assert.ok(protectedLine('finalized'));
  assert.ok(protectedLine('candidate'));
});

test('Conditional Production-Tag Update Rejects Changed Unreleased Snapshot', () => {
  assert.ok(protectedLine('snapshots'));
});

test('Already Released Unit Is Represented By Baseline', () => {
  assert.ok(protectedLine('represented'));
});

test('Conditional Production-Tag Update Readback Mismatch Stops Before Push', () => {
  assert.ok(protectedLine('readback'));
});

test('every protected operative clause is unique and removing it fails its own guard', () => {
  const canonical = readFileSync(repoPath(paths.invariant), 'utf8');
  assert.equal(subsetInvariant(canonical.replace(/\r?\n/g, '\r\n')), sources.invariant, 'canonical owner extraction must handle CRLF');
  assert.throws(() => subsetInvariant(canonical.replace('### Requirement: Release Subset Of Main Invariant', '### Requirement: Wrong Owner')), { name: 'AssertionError', message: /^subset invariant authority must exist exactly once/ });
  assert.throws(() => subsetInvariant(`${canonical}\n### Requirement: Release Subset Of Main Invariant\n`), { name: 'AssertionError', message: /^subset invariant authority must exist exactly once/ });
  for (const eol of ['\n', '\r\n']) {
    const input = sources.invariant.replace(/\n/g, eol);
    const line = canonicalProvenanceLine(input);
    const mutated = input.split(eol).filter(value => value !== line).join(eol);
    assert.notEqual(mutated, input, 'canonical provenance deletion must change the input');
    assert.throws(() => canonicalProvenanceLine(mutated), { name: 'AssertionError', actual: 0, expected: 1, message: /^canonical provenance: missing or duplicated operative clause/ });
    assert.throws(() => canonicalProvenanceLine(`${input}${eol}${line}${eol}`), { name: 'AssertionError', actual: 2, expected: 1, message: /^canonical provenance: missing or duplicated operative clause/ });
  }
  for (const key of Object.keys(guards)) {
    const line = protectedLine(key);
    const [carrier] = guards[key];
    const mutated = { ...sources, [carrier]: sources[carrier].split('\n').filter(value => value !== line).join('\n') };
    assert.throws(() => protectedLine(key, mutated), { name: 'AssertionError', message: new RegExp(`^${key}: missing or duplicated operative`) }, key);
  }
});

function isolatedGitGraph(inheritedEnv = process.env) {
  const dir = mkdtempSync(path.join(tmpdir(), 'parallel-release-contract-'));
  // Git path/config/identity variables can redirect even init and plumbing writes.
  const env = Object.fromEntries(Object.entries(inheritedEnv).filter(([key]) => !/^GIT_/i.test(key)));
  Object.assign(env, {
    LC_ALL: 'C', LANG: 'C', LANGUAGE: 'C',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(dir, 'absent'),
    GIT_AUTHOR_NAME: 'Fixture', GIT_COMMITTER_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  });
  function git(args, expected = 0, input) {
    const result = spawnSync('git', ['-c', `core.hooksPath=${path.join(dir, 'absent-hooks')}`, '-c', `core.attributesFile=${path.join(dir, 'absent-attributes')}`, ...args], { cwd: dir, env, input, encoding: 'utf8' });
    assert.equal(result.status, expected, `${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  }
  function tree(files) {
    for (const [file, value] of Object.entries(files)) writeFileSync(path.join(dir, file), value);
    git(['add', '.']);
    return git(['write-tree']);
  }
  function commit(treeOid, parents = []) {
    return git(['commit-tree', treeOid, ...parents.flatMap(parent => ['-p', parent])], 0, 'fixture\n');
  }
  try {
    git(['init', '-q', '--template=']);
    const kTree = tree({ 'feature.txt': 'off\n', 'version.txt': '1\n' });
    const K = commit(kTree);
    // Probe the operation itself rather than guessing a minimum Git version.
    assert.equal(git(['merge-tree', '--write-tree', K, K]).split('\n')[0], kTree, 'Git must support merge-tree --write-tree');
    const pTree = tree({ 'feature.txt': 'on\n', 'version.txt': '2\n' });
    const P = commit(pTree, [K]);
    // Ancestor predicate passes even when the feature is reverted.
    const reverted = commit(kTree, [P]);
    git(['merge-base', '--is-ancestor', P, reverted]);
    assert.equal(git(['show', `${reverted}:feature.txt`]), 'off');
    assert.notEqual(git(['rev-parse', `${reverted}^{tree}`]), pTree);
    const unitTree = tree({ 'feature.txt': 'off\n', 'version.txt': '1\n', 'unit.txt': 'approved\n' });
    const U = commit(unitTree, [K]);
    const main = commit(unitTree, [K, U]);
    git(['merge-base', '--is-ancestor', U, main]);
    const preview = git(['merge-tree', '--write-tree', P, U]).split('\n')[0];
    const assembly = commit(preview, [P, U]);
    git(['merge-base', '--is-ancestor', assembly, main], 1);
    assert.equal(git(['show', `${assembly}:feature.txt`]), 'on');
    assert.equal(git(['show', `${assembly}:unit.txt`]), 'approved');
    assert.equal(git(['rev-parse', `${assembly}^2`]), U);
    const injectedTree = tree({ 'feature.txt': 'on\n', 'version.txt': '2\n', 'unit.txt': 'approved\n', 'patch.txt': 'unapproved\n' });
    const forged = commit(injectedTree, [P, U]);
    assert.equal(git(['rev-parse', `${forged}^2`]), U);
    assert.notEqual(git(['rev-parse', `${forged}^{tree}`]), preview, 'same approved parents cannot legalize release-only content (including single-round)');
    const wrongParent = commit(preview, [P, K]);
    assert.notEqual(git(['rev-parse', `${wrongParent}^2`]), U, 'equal tree cannot legalize wrong parent');
    const moved = commit(unitTree, [U]);
    git(['update-ref', 'refs/remotes/origin/feature/unit', U]);
    const snapshot = git(['rev-parse', 'origin/feature/unit']);
    git(['update-ref', 'refs/remotes/origin/feature/unit', moved]);
    assert.notEqual(git(['rev-parse', 'origin/feature/unit']), snapshot, 'fresh remote tip must invalidate old snapshot');
    const bumpTree = tree({ 'feature.txt': 'off\n', 'version.txt': '3\n', 'unit.txt': 'approved\n', 'patch.txt': 'unapproved\n' });
    const bump = commit(bumpTree, [K]);
    const conflict = git(['merge-tree', '--write-tree', P, bump], 1);
    assert.match(conflict, /CONFLICT \(content\): Merge conflict in version\.txt/);
    assert.equal(git(['merge-tree', '--write-tree', assembly, P]).split('\n')[0], preview, 'already represented tag is a tree no-op; provenance checks remain separate');
    // Own promotion advances Q to M; an unrelated N invalidates expected M.
    const Q = P;
    const R = assembly;
    const T = git(['merge-tree', '--write-tree', Q, R]).split('\n')[0];
    const M = commit(T, [Q, R]);
    git(['update-ref', 'refs/heads/production', Q]);
    git(['update-ref', 'refs/heads/production', M, Q]);
    assert.equal(git(['rev-parse', 'production']), M);
    assert.equal(git(['show', '-s', '--format=%P', M]), `${Q} ${R}`);
    assert.equal(git(['rev-parse', `${M}^{tree}`]), T);
    const N = commit(injectedTree, [M]);
    git(['update-ref', 'refs/heads/production', N, M]);
    assert.notEqual(git(['rev-parse', 'production']), M);
    git(['update-ref', 'refs/heads/production', M, M], 128);
    git(['merge-base', '--is-ancestor', M, N]);
    assert.ok(protectedLine('content'));
    assert.ok(protectedLine('unauthorized'));
    assert.ok(protectedLine('parents'));
    assert.ok(protectedLine('snapshots'));
    assert.ok(protectedLine('bump'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}


test('isolated Git graph negatives: ancestry/revert, unauthorized single content, wrong parents/tree, moved snapshot, metadata conflict, own production drift', () => {
  isolatedGitGraph();
});

function snapshotDirectory(root) {
  const snapshot = {};
  function visit(dir) {
    for (const name of readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      const relative = path.relative(root, file);
      const stat = lstatSync(file);
      if (stat.isDirectory()) {
        snapshot[relative] = 'directory';
        visit(file);
      } else if (stat.isSymbolicLink()) {
        snapshot[relative] = `symlink:${readlinkSync(file)}`;
      } else {
        snapshot[relative] = createHash('sha256').update(readFileSync(file)).digest('hex');
      }
    }
  }
  visit(root);
  return snapshot;
}

test('isolated Git graph ignores adversarial inherited Git environment and preserves external repository bytes', () => {
  const external = mkdtempSync(path.join(tmpdir(), 'parallel-release-external-'));
  const gitDir = path.join(external, '.git');
  const cleanEnv = {
    PATH: process.env.PATH, LC_ALL: 'C', LANG: 'C', LANGUAGE: 'C',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(external, 'absent'),
    GIT_AUTHOR_NAME: 'External Fixture', GIT_COMMITTER_NAME: 'External Fixture',
    GIT_AUTHOR_EMAIL: 'external@example.invalid', GIT_COMMITTER_EMAIL: 'external@example.invalid',
  };
  function externalGit(args) {
    const result = spawnSync('git', args, { cwd: external, env: cleanEnv, encoding: 'utf8' });
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  }
  try {
    externalGit(['init', '-q', '--template=']);
    writeFileSync(path.join(external, 'sentinel.txt'), 'external bytes must remain unchanged\n');
    externalGit(['add', '.']);
    externalGit(['commit', '-qm', 'external sentinel']);
    const config = path.join(external, 'injected-config');
    writeFileSync(config, '[core]\n\tfileMode = false\n');
    const before = snapshotDirectory(external);
    let graphError;
    try {
      isolatedGitGraph({
        ...process.env,
        GIT_DIR: gitDir, GIT_WORK_TREE: external, GIT_COMMON_DIR: gitDir,
        GIT_INDEX_FILE: path.join(gitDir, 'index'),
        GIT_OBJECT_DIRECTORY: path.join(gitDir, 'objects'),
        GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(gitDir, 'objects'),
        GIT_CONFIG: config, GIT_CONFIG_SYSTEM: config, GIT_CONFIG_GLOBAL: config,
        GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: external,
        GIT_CONFIG_KEY_1: 'core.attributesFile', GIT_CONFIG_VALUE_1: config,
        GIT_CONFIG_PARAMETERS: "'core.fileMode'='false'",
        GIT_AUTHOR_NAME: 'Injected', GIT_COMMITTER_NAME: 'Injected',
        LC_ALL: 'fr_FR.UTF-8', LANG: 'fr_FR.UTF-8', LANGUAGE: 'fr',
      });
    } catch (error) { graphError = error; }
    assert.deepEqual(snapshotDirectory(external), before, 'fixture changed external refs, index, objects, or other repository bytes');
    assert.ifError(graphError);
  } finally {
    rmSync(external, { recursive: true, force: true });
  }
});
