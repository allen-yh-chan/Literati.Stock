// Every compliant branch form has a compliant deletion path that needs no `git push --no-verify`,
// or a documented "intentionally retained" outcome. Each case builds a real repo with a local bare
// origin and the real pre-push hook (core.hooksPath), runs the documented command, and checks what
// is left locally and on the origin. Nothing here talks to a network remote.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './lib/repo-root.mjs';
import { makeTempDir } from './lib/tmp.mjs';
import { acceptsPrintedPruneArgv, advisoryBranchArg, advisoryPathArg } from '../lib/prune-argv.mjs';

const PRUNE = path.join(REPO_ROOT, '.devpro/scripts/prune-merged-local.mjs');
const RULES_PRUNE = path.join(REPO_ROOT, '.devpro/scripts/prune-rules-lane.mjs');
const HOOKS = path.join(REPO_ROOT, '.devpro/scripts/hooks-git');
const roots = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args],
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function commit(work, label) {
  writeFileSync(path.join(work, `${label.replace(/[^A-Za-z0-9]/g, '_')}.txt`), `${label}\n`);
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '--no-verify', '-m', label);
}

// Setup pushes run before armHook, so only the command under test meets the hook.
function repo({ production = true } = {}) {
  const root = makeTempDir('branch-deletion-paths-');
  roots.push(root);
  const bare = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  git(root, 'init', '-q', '--bare', '-b', 'main', bare);
  mkdirSync(work);
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'remote', 'add', 'origin', bare);
  commit(work, 'init');
  git(work, 'push', '-q', '--no-verify', 'origin', 'main');
  if (production) git(work, 'push', '-q', '--no-verify', 'origin', 'main:production');
  git(work, 'fetch', '-q', 'origin');
  return work;
}

function pushBranch(work, branch) {
  git(work, 'checkout', '-q', '-b', branch, 'main');
  commit(work, branch);
  git(work, 'push', '-q', '--no-verify', 'origin', branch);
  git(work, 'checkout', '-q', 'main');
}

function mergeToMain(work, branch) {
  git(work, 'merge', '-q', '--no-ff', '--no-edit', branch);
  git(work, 'push', '-q', '--no-verify', 'origin', 'main');
}

const armHook = (work) => git(work, 'config', 'core.hooksPath', HOOKS);
const remoteHas = (work, branch) => git(work, 'ls-remote', 'origin', `refs/heads/${branch}`) !== '';
const localHas = (work, branch) => git(work, 'branch', '--list', branch) !== '';

function run(work, script, ...args) {
  const env = { ...process.env };
  delete env.DEVPRO_PRUNE_REMOTE_DELETE;
  return spawnSync('node', [script, ...args], { cwd: work, encoding: 'utf8', env });
}

function rawRemoteDelete(work, branch) {
  const env = { ...process.env };
  delete env.DEVPRO_PRUNE_REMOTE_DELETE;
  return spawnSync('git', ['push', 'origin', '--delete', branch], { cwd: work, encoding: 'utf8', env });
}

const out = (r) => `status=${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`;

// [Scenario: branch-hygiene-tooling :: An abandoned pushed branch is deleted by name together with its remote ref]
describe('abandoned pushed work branch', () => {
  it('--force-delete <branch> --include-remote deletes the local and remote refs under a lease, through the real hook', () => {
    const work = repo();
    pushBranch(work, 'feature/abandoned');
    armHook(work);
    const r = run(work, PRUNE, '--force-delete', 'feature/abandoned', '--include-remote');
    assert.equal(r.status, 0, out(r));
    assert.match(r.stdout, /--force-with-lease=refs\/heads\/feature\/abandoned:[0-9a-f]{40}/, out(r));
    assert.equal(localHas(work, 'feature/abandoned'), false, out(r));
    assert.equal(remoteHas(work, 'feature/abandoned'), false, out(r));
  });

  it('deletes the remote ref alone when the local ref is already gone', () => {
    const work = repo();
    pushBranch(work, 'feature/remote-only');
    git(work, 'branch', '-D', 'feature/remote-only');
    armHook(work);
    const r = run(work, PRUNE, '--force-delete', 'feature/remote-only', '--include-remote');
    assert.equal(r.status, 0, out(r));
    assert.equal(remoteHas(work, 'feature/remote-only'), false, out(r));
  });

  it('without --include-remote only the local ref is deleted', () => {
    const work = repo();
    pushBranch(work, 'feature/local-only');
    armHook(work);
    const r = run(work, PRUNE, '--force-delete', 'feature/local-only');
    assert.equal(r.status, 0, out(r));
    assert.equal(localHas(work, 'feature/local-only'), false);
    assert.equal(remoteHas(work, 'feature/local-only'), true);
  });

  it('a raw git push --delete is still blocked, and the advisory names the per-branch command and the subsumed path', () => {
    const work = repo();
    pushBranch(work, 'feature/raw');
    armHook(work);
    const r = rawRemoteDelete(work, 'feature/raw');
    assert.notEqual(r.status, 0, out(r));
    assert.equal(remoteHas(work, 'feature/raw'), true);
    assert.match(r.stderr, /prune-merged-local\.mjs --force-delete feature\/raw --include-remote/, out(r));
    assert.match(r.stderr, /prune-merged-local\.mjs --include-subsumed --include-remote --exec/, out(r));
    assert.match(r.stderr, /Commits only on that branch are lost on both sides/, out(r));
    assert.match(r.stderr, /refuses one with uncommitted or untracked changes/, out(r));
  });
});

// [Scenario: branch-hygiene-tooling :: Named remote deletion refuses branches that the batch paths own]
describe('branches already in main or production keep their batch paths', () => {
  it('merged into main but not shipped: refused, pointing to the unshipped-mainline command; nothing deleted', () => {
    const work = repo();
    pushBranch(work, 'feature/merged');
    mergeToMain(work, 'feature/merged');
    armHook(work);
    const r = run(work, PRUNE, '--force-delete', 'feature/merged', '--include-remote');
    assert.notEqual(r.status, 0, out(r));
    assert.match(r.stderr, /prune-merged-local\.mjs --include-unshipped-mainline --include-remote --exec/, out(r));
    assert.equal(localHas(work, 'feature/merged'), true);
    assert.equal(remoteHas(work, 'feature/merged'), true);
  });

  // rule-feedback #3568: deleting the remote ref before production makes the next
  // release Step 1 label the unit `restore`, so the dry run must say so at the
  // decision point instead of surprising the operator a round later.
  it('dry run warns that clearing unshipped-mainline remote refs makes the next release Step 1 report restore', () => {
    const work = repo();
    pushBranch(work, 'feature/merged-not-shipped');
    mergeToMain(work, 'feature/merged-not-shipped');
    const r = run(work, PRUNE);
    assert.equal(r.status, 0, out(r));
    assert.match(r.stdout, /origin\/feature\/merged-not-shipped\s+\[unshipped-mainline\]/, out(r));
    assert.match(
      r.stdout,
      /Deleting these remote refs before production makes the next release Step 1 label each unit `restore`/,
      out(r),
    );
    assert.match(r.stdout, /release-step-1-7\.md Step 1 branch-health check 4 requires refs\/remotes\/origin\/<branch>/, out(r));
    assert.equal(remoteHas(work, 'feature/merged-not-shipped'), true, out(r));
  });

  it('shipped: refused, pointing to --include-remote --exec; nothing deleted', () => {
    const work = repo();
    pushBranch(work, 'feature/shipped');
    mergeToMain(work, 'feature/shipped');
    git(work, 'push', '-q', '--no-verify', 'origin', 'main:production');
    armHook(work);
    const r = run(work, PRUNE, '--force-delete', 'feature/shipped', '--include-remote');
    assert.notEqual(r.status, 0, out(r));
    assert.match(r.stderr, /prune-merged-local\.mjs --include-remote --exec/, out(r));
    assert.equal(remoteHas(work, 'feature/shipped'), true);
  });

  it('a rules/* branch merged into main: refused, pointing to prune-rules-lane', () => {
    const work = repo();
    pushBranch(work, 'rules/agent-rules-v0.2.0');
    mergeToMain(work, 'rules/agent-rules-v0.2.0');
    armHook(work);
    const r = run(work, PRUNE, '--force-delete', 'rules/agent-rules-v0.2.0', '--include-remote');
    assert.notEqual(r.status, 0, out(r));
    assert.match(r.stderr, /prune-rules-lane\.mjs --include-remote --exec/, out(r));
    assert.equal(remoteHas(work, 'rules/agent-rules-v0.2.0'), true);
  });
});

// [Scenario: branch-hygiene-tooling :: Named remote deletion deletes nothing when origin cannot be checked]
describe('checks fail before any deletion', () => {
  it('when origin cannot be fetched, the command exits non-zero and the local ref stays', () => {
    const work = repo();
    pushBranch(work, 'feature/offline');
    git(work, 'remote', 'set-url', 'origin', path.join(path.dirname(work), 'missing.git'));
    const r = run(work, PRUNE, '--force-delete', 'feature/offline', '--include-remote');
    assert.notEqual(r.status, 0, out(r));
    assert.match(r.stderr, /未刪除任何東西/, out(r));
    assert.equal(localHas(work, 'feature/offline'), true, out(r));
  });
});

// The origin's pre-receive hook decides the outcome; `deleteFirst` simulates a server
// that applied the delete but still reported failure.
function failRemoteDelete(work, branch, { deleteFirst }) {
  const hook = path.join(path.dirname(work), 'origin.git', 'hooks', 'pre-receive');
  const body = deleteFirst
    ? `#!/bin/sh\nunset GIT_QUARANTINE_PATH\ngit update-ref -d refs/heads/${branch}\nexit 1\n`
    : '#!/bin/sh\nexit 1\n';
  writeFileSync(hook, body, { mode: 0o755 });
}

// [Scenario: branch-hygiene-tooling :: A failed remote delete reports what origin actually holds]
describe('a failed remote delete is reported from what origin holds', () => {
  it('rejected push: origin retained, local untouched', () => {
    const work = repo();
    pushBranch(work, 'feature/rejected');
    failRemoteDelete(work, 'feature/rejected', { deleteFirst: false });
    armHook(work);
    const r = run(work, PRUNE, '--force-delete', 'feature/rejected', '--include-remote');
    assert.notEqual(r.status, 0, out(r));
    assert.match(r.stderr, /origin\/feature\/rejected retained; local branch untouched/, out(r));
    assert.equal(remoteHas(work, 'feature/rejected'), true);
    assert.equal(localHas(work, 'feature/rejected'), true);
  });

  it('push failed after origin applied the delete: reported as deleted, local untouched', () => {
    const work = repo();
    pushBranch(work, 'feature/lost-reply');
    failRemoteDelete(work, 'feature/lost-reply', { deleteFirst: true });
    armHook(work);
    const r = run(work, PRUNE, '--force-delete', 'feature/lost-reply', '--include-remote');
    assert.notEqual(r.status, 0, out(r));
    assert.match(r.stderr, /origin\/feature\/lost-reply deleted despite the push error; local branch untouched/, out(r));
    assert.doesNotMatch(r.stderr, /retained;/, out(r));
    assert.equal(remoteHas(work, 'feature/lost-reply'), false);
    assert.equal(localHas(work, 'feature/lost-reply'), true);
  });
});

// [Scenario: branch-hygiene-tooling :: Abandoned release branches are retained]
describe('abandoned release branches are retained', () => {
  it('--include-remote rejects release/* with or without --allow-release, and the remote ref stays', () => {
    const work = repo();
    pushBranch(work, 'release/v9.9.9');
    armHook(work);
    for (const args of [['--force-delete', 'release/v9.9.9', '--include-remote'], ['--force-delete', '--allow-release', 'release/v9.9.9', '--include-remote']]) {
      const r = run(work, PRUNE, ...args);
      assert.notEqual(r.status, 0, out(r));
      assert.match(r.stderr, /刻意保留/, out(r));
    }
    assert.equal(remoteHas(work, 'release/v9.9.9'), true);
    assert.equal(localHas(work, 'release/v9.9.9'), true);
  });

  it('the hook advisory does not offer a deletion command for a release branch', () => {
    const work = repo();
    pushBranch(work, 'release/rules-20990101');
    armHook(work);
    const r = rawRemoteDelete(work, 'release/rules-20990101');
    assert.notEqual(r.status, 0, out(r));
    assert.doesNotMatch(r.stderr, /--force-delete release\//, out(r));
    assert.match(r.stderr, /intentionally retained/, out(r));
  });
});

// [Scenario: branch-hygiene-tooling :: An unmerged rules branch gets a next step]
describe('rules/* not merged into main', () => {
  it('prune-rules-lane names the next step for an abandoned branch, and that command deletes it', () => {
    const work = repo();
    pushBranch(work, 'rules/agent-rules-v0.1.0');
    const dry = run(work, RULES_PRUNE);
    assert.equal(dry.status, 0, out(dry));
    assert.match(dry.stdout, /prune-merged-local\.mjs --force-delete rules\/agent-rules-v0\.1\.0 --include-remote/, out(dry));
    assert.match(dry.stdout, /PR is still open/, out(dry));
    assert.match(dry.stdout, /refuses one with uncommitted or untracked changes/, out(dry));
    armHook(work);
    const r = run(work, PRUNE, '--force-delete', 'rules/agent-rules-v0.1.0', '--include-remote');
    assert.equal(r.status, 0, out(r));
    assert.equal(remoteHas(work, 'rules/agent-rules-v0.1.0'), false, out(r));
  });
});

// [Scenario: branch-hygiene-tooling :: Without a production branch the main-contained tier still runs]
describe('no production branch yet', () => {
  it('plain --exec deletes nothing; --include-unshipped-mainline --include-remote --exec deletes main-contained branches', () => {
    const work = repo({ production: false });
    pushBranch(work, 'feature/pre-release');
    mergeToMain(work, 'feature/pre-release');
    armHook(work);
    const plain = run(work, PRUNE, '--exec');
    assert.equal(plain.status, 0, out(plain));
    assert.match(plain.stdout, /no production branch found/, out(plain));
    assert.equal(localHas(work, 'feature/pre-release'), true, out(plain));
    assert.equal(remoteHas(work, 'feature/pre-release'), true, out(plain));
    const r = run(work, PRUNE, '--include-unshipped-mainline', '--include-remote', '--exec');
    assert.equal(r.status, 0, out(r));
    assert.equal(localHas(work, 'feature/pre-release'), false, out(r));
    assert.equal(remoteHas(work, 'feature/pre-release'), false, out(r));
  });
});

// [Scenario: branch-hygiene-tooling :: Branch states the rules forbid still have a named way out]
describe('states that should not exist still have a way out', () => {
  it('a branch squash-merged into main before shipping is removed by --force-delete --include-remote', () => {
    const work = repo();
    pushBranch(work, 'feature/squashed');
    git(work, 'merge', '-q', '--squash', 'feature/squashed');
    git(work, 'commit', '-q', '--no-verify', '-m', 'squash feature/squashed');
    git(work, 'push', '-q', '--no-verify', 'origin', 'main');
    armHook(work);
    const r = run(work, PRUNE, '--force-delete', 'feature/squashed', '--include-remote');
    assert.equal(r.status, 0, out(r));
    assert.equal(remoteHas(work, 'feature/squashed'), false, out(r));
  });

  it('a review/ branch that leaked to the remote is removed by --force-delete --include-remote', () => {
    const work = repo();
    pushBranch(work, 'review/pr1');
    armHook(work);
    const r = run(work, PRUNE, '--force-delete', 'review/pr1', '--include-remote');
    assert.equal(r.status, 0, out(r));
    assert.equal(localHas(work, 'review/pr1'), false, out(r));
    assert.equal(remoteHas(work, 'review/pr1'), false, out(r));
  });
});

// A release lane the way Step 2-6 builds it: the release branch is cut from main (here it is
// main's tip, the full-main case), merged into production with --no-ff, and the production merge
// commit is tagged. Step 6A has not run yet, so main does not contain the tag.
function shipRelease(work, branch, tag) {
  git(work, 'checkout', '-q', '-b', branch, 'main');
  git(work, 'push', '-q', '--no-verify', 'origin', branch);
  git(work, 'checkout', '-q', '-B', 'production', 'origin/production');
  git(work, 'merge', '-q', '--no-ff', '--no-edit', branch);
  git(work, 'tag', tag);
  git(work, 'push', '-q', '--no-verify', 'origin', 'production', tag);
  git(work, 'checkout', '-q', 'main');
  git(work, 'branch', '-D', 'production');
  git(work, 'fetch', '-q', 'origin');
}

// Step 6A: the promoted tag is merged back into main.
function backMerge(work, tag) {
  git(work, 'merge', '-q', '--no-ff', '--no-edit', tag);
  git(work, 'push', '-q', '--no-verify', 'origin', 'main');
}

function shipFeature(work, branch) {
  pushBranch(work, branch);
  mergeToMain(work, branch);
  git(work, 'push', '-q', '--no-verify', 'origin', 'main:production');
  git(work, 'fetch', '-q', 'origin');
}

function addWorktree(work, branch) {
  const wt = path.join(path.dirname(work), `wt-${branch.replace(/[^A-Za-z0-9]/g, '-')}`);
  git(work, 'worktree', 'add', '-q', wt, branch);
  return realpathSync(wt); // git lists the resolved path (macOS /var → /private/var)
}

const worktreeListed = (work, wt) => git(work, 'worktree', 'list', '--porcelain').includes(`worktree ${wt}`);

// [Scenario: branch-hygiene-tooling :: A shipped release branch is kept until Step 6A merges it back into main]
describe('a shipped release branch waits for the Step 6A back-merge', () => {
  it('a full-main release is kept until its production tag is in origin/main, then deleted', () => {
    const work = repo();
    commit(work, 'release content');
    git(work, 'push', '-q', '--no-verify', 'origin', 'main');
    shipRelease(work, 'release/v1.0.0', 'production-v1.0.0');
    armHook(work);
    // The release tip is main's tip, so "tip in origin/main" alone would wrongly allow deletion.
    const dry = run(work, PRUNE);
    assert.equal(dry.status, 0, out(dry));
    assert.match(dry.stdout, /kept until Step 6A[\s\S]*release\/v1\.0\.0/, out(dry));
    const early = run(work, PRUNE, '--include-remote', '--exec');
    assert.equal(early.status, 0, out(early));
    assert.equal(localHas(work, 'release/v1.0.0'), true, out(early));
    assert.equal(remoteHas(work, 'release/v1.0.0'), true, out(early));
    backMerge(work, 'production-v1.0.0');
    const r = run(work, PRUNE, '--include-remote', '--exec');
    assert.equal(r.status, 0, out(r));
    assert.equal(localHas(work, 'release/v1.0.0'), false, out(r));
    assert.equal(remoteHas(work, 'release/v1.0.0'), false, out(r));
  });

  it('when origin/main cannot be read the release branch is kept', () => {
    const work = repo();
    shipRelease(work, 'release/v2.0.0', 'production-v2.0.0');
    backMerge(work, 'production-v2.0.0');
    git(work, 'update-ref', '-d', 'refs/remotes/origin/main');
    const r = run(work, PRUNE, '--local-only', '--exec');
    assert.equal(r.status, 0, out(r));
    assert.equal(localHas(work, 'release/v2.0.0'), true, out(r));
  });
});

// [Scenario: branch-hygiene-tooling :: prune-merged-local leaves release/rules-* to prune-rules-lane]
describe('release/rules-* belongs to prune-rules-lane', () => {
  it('prune-merged-local neither lists nor deletes a shipped release/rules-* branch', () => {
    const work = repo();
    shipRelease(work, 'release/rules-20990101', 'production-20990101-rules');
    armHook(work);
    const r = run(work, PRUNE, '--include-remote', '--exec');
    assert.equal(r.status, 0, out(r));
    assert.doesNotMatch(r.stdout, /release\/rules-20990101/, out(r));
    assert.equal(localHas(work, 'release/rules-20990101'), true, out(r));
    assert.equal(remoteHas(work, 'release/rules-20990101'), true, out(r));
  });
});

// [Scenario: branch-hygiene-tooling :: A worktree with uncommitted changes is never removed]
describe('worktrees with uncommitted or untracked changes', () => {
  it('the batch run skips a dirty worktree and its branch, and removes a clean one that only carries the node_modules link', () => {
    const work = repo();
    shipFeature(work, 'feature/dirty');
    shipFeature(work, 'feature/clean');
    const dirty = addWorktree(work, 'feature/dirty');
    const clean = addWorktree(work, 'feature/clean');
    writeFileSync(path.join(dirty, 'unsaved.txt'), 'work in progress\n');
    symlinkSync(path.join(path.dirname(work), 'origin.git'), path.join(clean, 'node_modules'));
    const dry = run(work, PRUNE);
    assert.equal(dry.status, 0, out(dry));
    assert.match(dry.stdout, /uncommitted or untracked changes[\s\S]*wt-feature-dirty/, out(dry));
    const r = run(work, PRUNE, '--exec');
    assert.equal(r.status, 0, out(r));
    assert.equal(worktreeListed(work, dirty), true, out(r));
    assert.equal(localHas(work, 'feature/dirty'), true, out(r));
    assert.equal(readFileSync(path.join(dirty, 'unsaved.txt'), 'utf8'), 'work in progress\n');
    assert.equal(worktreeListed(work, clean), false, out(r));
    assert.equal(localHas(work, 'feature/clean'), false, out(r));
    assert.doesNotMatch(r.stdout, /worktree remove --force/, out(r));
  });

  it('--force-delete --include-remote refuses a branch whose worktree has uncommitted changes and deletes nothing', () => {
    const work = repo();
    pushBranch(work, 'feature/wip');
    const wt = addWorktree(work, 'feature/wip');
    writeFileSync(path.join(wt, `${'feature_wip'}.txt`), 'edited\n');
    armHook(work);
    const r = run(work, PRUNE, '--force-delete', 'feature/wip', '--include-remote');
    assert.notEqual(r.status, 0, out(r));
    assert.match(r.stderr, /uncommitted or untracked changes/, out(r));
    assert.match(r.stderr, /未刪除任何東西/, out(r));
    assert.equal(worktreeListed(work, wt), true, out(r));
    assert.equal(localHas(work, 'feature/wip'), true, out(r));
    assert.equal(remoteHas(work, 'feature/wip'), true, out(r));
  });

  it('an untracked file is still seen when status.showUntrackedFiles=no', () => {
    const work = repo();
    shipFeature(work, 'feature/hidden');
    pushBranch(work, 'feature/hidden-named');
    const batch = addWorktree(work, 'feature/hidden');
    const named = addWorktree(work, 'feature/hidden-named');
    git(work, 'config', 'status.showUntrackedFiles', 'no');
    writeFileSync(path.join(batch, 'unsaved.txt'), 'work in progress\n');
    writeFileSync(path.join(named, 'unsaved.txt'), 'work in progress\n');
    armHook(work);
    const r = run(work, PRUNE, '--exec');
    assert.equal(r.status, 0, out(r));
    assert.equal(worktreeListed(work, batch), true, out(r));
    assert.equal(readFileSync(path.join(batch, 'unsaved.txt'), 'utf8'), 'work in progress\n');
    const f = run(work, PRUNE, '--force-delete', 'feature/hidden-named', '--include-remote');
    assert.notEqual(f.status, 0, out(f));
    assert.equal(worktreeListed(work, named), true, out(f));
    assert.equal(remoteHas(work, 'feature/hidden-named'), true, out(f));
  });

  it('--include-remote --exec keeps the remote ref of a branch whose worktree is dirty', () => {
    const work = repo();
    shipFeature(work, 'feature/dirty-remote');
    shipFeature(work, 'feature/clean-remote');
    const wt = addWorktree(work, 'feature/dirty-remote');
    writeFileSync(path.join(wt, 'unsaved.txt'), 'work in progress\n');
    armHook(work);
    const r = run(work, PRUNE, '--include-remote', '--exec');
    assert.equal(r.status, 0, out(r));
    assert.equal(worktreeListed(work, wt), true, out(r));
    assert.equal(localHas(work, 'feature/dirty-remote'), true, out(r));
    assert.equal(remoteHas(work, 'feature/dirty-remote'), true, out(r));
    assert.equal(remoteHas(work, 'feature/clean-remote'), false, out(r));
  });
});

// [Scenario: branch-hygiene-tooling :: Shipped remote branches are deleted under a lease]
describe('shipped remote deletion', () => {
  it('--include-remote --exec deletes a shipped remote branch under an OID lease', () => {
    const work = repo();
    shipFeature(work, 'feature/shipped-remote');
    armHook(work);
    const r = run(work, PRUNE, '--include-remote', '--exec');
    assert.equal(r.status, 0, out(r));
    assert.match(r.stdout, /--force-with-lease=refs\/heads\/feature\/shipped-remote:[0-9a-f]{40} :refs\/heads\/feature\/shipped-remote/, out(r));
    assert.equal(remoteHas(work, 'feature/shipped-remote'), false, out(r));
  });
});

// [Scenario: branch-hygiene-tooling :: prune-rules-lane fetches first and honours the keep list]
describe('prune-rules-lane reads current origin state and the keep list', () => {
  it('sees a rules branch that another clone merged into main', () => {
    const work = repo();
    pushBranch(work, 'rules/agent-rules-v0.3.0');
    const other = path.join(path.dirname(work), 'other');
    git(path.dirname(work), 'clone', '-q', path.join(path.dirname(work), 'origin.git'), other);
    git(other, 'merge', '-q', '--no-ff', '--no-edit', 'origin/rules/agent-rules-v0.3.0');
    git(other, 'push', '-q', '--no-verify', 'origin', 'main');
    const r = run(work, RULES_PRUNE);
    assert.equal(r.status, 0, out(r));
    assert.match(r.stdout, /Eligible local \(1\):\n {2}- rules\/agent-rules-v0\.3\.0/, out(r));
  });

  it('refuses --exec when origin cannot be fetched, and deletes nothing', () => {
    const work = repo();
    pushBranch(work, 'rules/agent-rules-v0.4.0');
    mergeToMain(work, 'rules/agent-rules-v0.4.0');
    git(work, 'fetch', '-q', 'origin');
    git(work, 'remote', 'set-url', 'origin', path.join(path.dirname(work), 'missing.git'));
    const dry = run(work, RULES_PRUNE);
    assert.equal(dry.status, 0, out(dry));
    assert.match(dry.stdout, /git fetch --prune failed/, out(dry));
    assert.match(dry.stdout, /--exec is refused until git fetch --prune succeeds/, out(dry));
    const r = run(work, RULES_PRUNE, '--exec');
    assert.notEqual(r.status, 0, out(r));
    assert.equal(localHas(work, 'rules/agent-rules-v0.4.0'), true, out(r));
  });

  it('skips branches on the keep list', () => {
    const work = repo();
    pushBranch(work, 'rules/agent-rules-v0.5.0');
    mergeToMain(work, 'rules/agent-rules-v0.5.0');
    const r0 = run(work, PRUNE, '--keep', 'rules/agent-rules-v0.5.0');
    assert.equal(r0.status, 0, out(r0));
    armHook(work);
    const r = run(work, RULES_PRUNE, '--include-remote', '--exec');
    assert.equal(r.status, 0, out(r));
    assert.match(r.stdout, /keep 清單/, out(r));
    assert.equal(localHas(work, 'rules/agent-rules-v0.5.0'), true, out(r));
    assert.equal(remoteHas(work, 'rules/agent-rules-v0.5.0'), true, out(r));
  });

  it('run from a linked worktree, it reads the keep list written in the main checkout', () => {
    const work = repo();
    pushBranch(work, 'rules/agent-rules-v0.6.0');
    mergeToMain(work, 'rules/agent-rules-v0.6.0');
    const r0 = run(work, PRUNE, '--keep', 'rules/agent-rules-v0.6.0');
    assert.equal(r0.status, 0, out(r0));
    git(work, 'branch', 'feature/elsewhere', 'main');
    const other = addWorktree(work, 'feature/elsewhere');
    armHook(work);
    const r = run(other, RULES_PRUNE, '--include-remote', '--exec');
    assert.equal(r.status, 0, out(r));
    assert.equal(localHas(work, 'rules/agent-rules-v0.6.0'), true, out(r));
    assert.equal(remoteHas(work, 'rules/agent-rules-v0.6.0'), true, out(r));
  });

  it('--keep run from a linked worktree writes the shared keep list', () => {
    const work = repo();
    git(work, 'branch', 'feature/elsewhere', 'main');
    const other = addWorktree(work, 'feature/elsewhere');
    const r = run(other, PRUNE, '--keep', 'feature/keep-me');
    assert.equal(r.status, 0, out(r));
    assert.match(readFileSync(path.join(work, '.git', 'info', 'deletable-keep'), 'utf8'), /^feature\/keep-me$/m);
  });
});

describe('pre-push hook literals', () => {
  it('the protected names the hook uses for its advisory match isProtectedBaseBranch', async () => {
    const source = readFileSync(path.join(HOOKS, 'pre-push.mjs'), 'utf8');
    const literal = /^const PROTECTED_BRANCH_NAMES = \[([^\]]+)\];$/m.exec(source);
    assert.ok(literal, 'pre-push.mjs must declare PROTECTED_BRANCH_NAMES as an array literal');
    const names = [...literal[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    const { isProtectedBaseBranch } = await import('../hooks/lib/branch-naming.mjs');
    assert.deepEqual(names.filter((n) => !isProtectedBaseBranch(n)), []);
    // The lib set is exactly these four names; a fifth there must be added here too.
    assert.deepEqual([...names].sort(), ['integration', 'main', 'master', 'production']);
  });

  it('the hook prints a branch name with shell characters the same way as advisoryBranchArg', () => {
    const work = repo();
    const branch = "feature/it's&x";
    pushBranch(work, branch);
    armHook(work);
    const r = rawRemoteDelete(work, branch);
    assert.notEqual(r.status, 0, out(r));
    const arg = advisoryBranchArg(branch);
    if (arg === null) {
      assert.match(r.stderr, /quote it for your shell/, out(r));
    } else {
      assert.ok(r.stderr.includes(`--force-delete ${arg} --include-remote`), out(r));
    }
  });

  it('on Windows the hook prints no executable command for a non-plain name, like advisoryBranchArg', () => {
    const hook = readFileSync(path.join(HOOKS, 'pre-push.mjs'), 'utf8');
    assert.match(hook, /if \(process\.platform === 'win32'\) return null;/);
    assert.equal(advisoryBranchArg("feature/it's&x", 'win32'), null);
  });
});

describe('advisory branch argument', () => {
  it('plain names stay bare everywhere; others are POSIX-quoted, or null on Windows', () => {
    assert.equal(advisoryBranchArg('feature/a-b_c.1', 'win32'), 'feature/a-b_c.1');
    assert.equal(advisoryBranchArg('feature/a-b_c.1', 'linux'), 'feature/a-b_c.1');
    assert.equal(advisoryBranchArg('feature/fix!', 'win32'), null);
    assert.equal(advisoryBranchArg('feature/50%', 'win32'), null);
    assert.equal(advisoryBranchArg("feature/it's&x", 'darwin'), "'feature/it'\\''s&x'");
    // No cmd-only escapes (`""`, `%%`, `^!`) on Windows: PowerShell would keep them.
    assert.equal(advisoryBranchArg('chore/%PATH%', 'win32'), null);
    assert.equal(advisoryBranchArg('feat/"x"', 'win32'), null);
  });
});

describe('advisory path argument', () => {
  it('single-quotes a path on POSIX', () => {
    assert.equal(advisoryPathArg('/repo/my work/.worktree/fix-x', 'darwin'), "'/repo/my work/.worktree/fix-x'");
    assert.equal(advisoryPathArg("/repo/it's/.worktree/x", 'linux'), "'/repo/it'\\''s/.worktree/x'");
  });

  it('double-quotes a Windows path made only of letters, digits, space and . _ \\ / : -', () => {
    assert.equal(
      advisoryPathArg('C:\\Repos\\my repo\\.worktree\\fix-x_1.2', 'win32'),
      '"C:\\Repos\\my repo\\.worktree\\fix-x_1.2"',
    );
    assert.equal(advisoryPathArg('D:/work/.worktree/x', 'win32'), '"D:/work/.worktree/x"');
  });

  it('returns null on Windows for any other path, so no shell-specific escape is printed', () => {
    for (const p of [
      'C:\\a\\50%',
      'C:\\a\\x!y',
      'C:\\a\\$env',
      "C:\\a\\it's",
      'C:\\a\\x&y',
      'C:\\a\\x`y',
      'C:\\a\\x"y',
      'C:\\a\\x(1)',
      // Git Bash turns a doubled backslash inside double quotes into one.
      '\\\\server\\share\\.worktree\\x',
      // A trailing backslash would escape the closing quote.
      'C:\\a\\',
    ]) {
      assert.equal(advisoryPathArg(p, 'win32'), null, p);
    }
  });
});

describe('printed command shapes', () => {
  it('accepts the named remote deletion and rejects it for release branches or with --local-only', () => {
    assert.equal(acceptsPrintedPruneArgv(['--force-delete', 'feature/x', '--include-remote']), true);
    assert.equal(acceptsPrintedPruneArgv(['--force-delete', 'release/x', '--include-remote']), false);
    assert.equal(acceptsPrintedPruneArgv(['--force-delete', '--allow-release', 'release/x', '--include-remote']), false);
    assert.equal(acceptsPrintedPruneArgv(['--local-only', '--force-delete', 'feature/x', '--include-remote']), false);
  });
});

describe('rule text', () => {
  const read = (rel) => readFileSync(path.join(REPO_ROOT, rel), 'utf8');

  it('git-branch-hygiene.md lists the named remote deletion and says abandoned release branches are retained', () => {
    const text = read('.devpro/agent-rules/git-branch-hygiene.md');
    assert.match(text, /prune-merged-local\.mjs --force-delete <branch> --include-remote/);
    assert.match(text, /放棄的 `release\/\*`（含 `release\/rules-\*`）刻意保留/);
  });

  it('git-pr-template-and-merge.md no longer sends post-release cleanup to the local-only --force-delete', () => {
    const text = read('.devpro/agent-rules/git-pr-template-and-merge.md');
    assert.doesNotMatch(text, /Release Step 6[^\n]*prune-merged-local\.mjs --force-delete/);
  });
});
