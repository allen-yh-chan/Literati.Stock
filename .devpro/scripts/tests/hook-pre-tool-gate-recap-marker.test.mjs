/** PreToolUse never records an unexecuted merge as own work or a Recap success. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from './lib/tmp.mjs';

const PRE_TOOL_GATE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../hooks/pre-tool-gate.mjs'
);
const CROSS_MODEL_SHA = 'a'.repeat(40);
const CROSS_MODEL_STICKY_PASS = [
  '<!-- cross-model-second-opinion:sticky -->',
  'verdict: PASS',
  `last_reviewed_sha: ${CROSS_MODEL_SHA}`,
  'dispatch_id: test-recap-marker-pass',
  'reason: Test fixture confirms the reviewed pull request head is approved.',
  'Rules: v1.0.0 · Tool: Claude Code · Model: claude-test',
].join('\n');

/**
 * Create a minimal tmp git repo with a given branch checked out.
 * Uses execSync with shell so the init + checkout sequence runs atomically.
 * Returns the path to the repo dir.
 */
function makeTmpRepo(branch) {
  const repoDir = makeTempDir('recap-marker-test-repo-');
  execSync(
    `git init && git -c user.email=t@t -c user.name=t commit --allow-empty -m init && git checkout -b ${branch}`,
    { cwd: repoDir, shell: true, stdio: 'ignore' }
  );
  return repoDir;
}

function runGate({ payload, markerDir, repoDir }) {
  const tempSentinelDir = makeTempDir('sentinel-test-');
  const branch = execSync('git branch --show-current', {
    cwd: repoDir,
    encoding: 'utf8',
  }).trim();
  try {
    return spawnSync('node', [PRE_TOOL_GATE], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      cwd: repoDir,
      env: {
        ...process.env,
        DEVPRO_AGENT_RULES_LEVEL: 'full',
        DEVPRO_HOOK_HOST: 'test',
        DEVPRO_RECAP_WRITTEN_DIR: path.join(markerDir, 'written'),
        DEVPRO_SESSION_REMINDER_STATE_DIR: path.join(markerDir, 'scoped'),
        CODEX_CI: '',
        CODEX_THREAD_ID: '',
        DEVPRO_RECAP_PENDING_DIR: markerDir,
        DEVPRO_SENTINEL_STATE_DIR: tempSentinelDir,
        DEVPRO_POSTMERGE_STATE_DIR: path.join(markerDir, 'postmerge'),
        DEVPRO_RECAP_STATE_DIR: path.join(markerDir, 'dedup'),
        // Default-on cross-model gate still fetches PR metadata for gh pr merge.
        // Mock a valid PASS sticky so these Gate 4 tests exercise marker
        // behavior only, including feature/* branches that cannot use chore-A.
        CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT: JSON.stringify({
          comments: [{ body: CROSS_MODEL_STICKY_PASS, url: 'https://example.invalid/sticky' }],
          headRefOid: CROSS_MODEL_SHA,
          headRefName: branch,
        }),
        CROSS_MODEL_MERGE_GATE_MOCK_BRANCH: branch,
        CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES: 'openspec/changes/test-change/proposal.md',
      },
    });
  } finally {
    try { rmSync(tempSentinelDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ── T1: positive — work branch (chore/test-branch) writes marker ──────────────

test('T1: outgoing chore merge never creates pending work or written success', () => {
  const markerDir = makeTempDir('recap-pending-test-');
  const repoDir = makeTmpRepo('chore/test-branch');
  try {
    const payload = {
      session_id: 'pre-marker-owned-session',
      tool_name: 'Bash',
      tool_input: {
        command: 'gh pr merge 414 --merge',
        cwd: repoDir,
      },
    };
    const result = runGate({ payload, markerDir, repoDir });
    assert.equal(
      result.status,
      0,
      `Expected exit 0, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
    );
    const markerPath = path.join(markerDir, encodeURIComponent('chore/test-branch'));
    assert.equal(existsSync(markerPath), false);
    assert.equal(existsSync(path.join(markerDir, 'written')), false);
    assert.equal(existsSync(path.join(markerDir, 'scoped')), false);
  } finally {
    rmSync(markerDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  }
});

// ── T2: negative — non-work branch (main) does NOT write marker ───────────────

test('T2 (negative): gh pr merge on main → no recap-pending marker written', () => {
  const markerDir = makeTempDir('recap-pending-test-');
  // Create a repo on main (just init + commit, no extra checkout)
  const repoDir = makeTempDir('recap-marker-test-repo-');
  try {
    execSync(
      `git init && git -c user.email=t@t -c user.name=t commit --allow-empty -m init`,
      { cwd: repoDir, shell: true, stdio: 'ignore' }
    );
    const payload = {
      session_id: 'pre-marker-owned-session',
      tool_name: 'Bash',
      tool_input: {
        command: 'gh pr merge 414 --merge',
        cwd: repoDir,
      },
    };
    const result = runGate({ payload, markerDir, repoDir });
    assert.equal(
      result.status,
      0,
      `Expected exit 0, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
    );
    // main is not a work branch — writeRecapPendingMarker is a no-op for main
    const mainMarker = path.join(markerDir, 'main');
    assert.equal(
      existsSync(mainMarker),
      false,
      `Expected NO marker for main branch at ${mainMarker}`
    );
  } finally {
    rmSync(markerDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  }
});

// ── T3: positive — different work branch (feature/test-feat) writes marker ───

test('T3: outgoing feature merge never creates pending work or written success', () => {
  const markerDir = makeTempDir('recap-pending-test-');
  const repoDir = makeTmpRepo('feature/test-feat');
  try {
    const payload = {
      session_id: 'pre-marker-owned-session',
      tool_name: 'Bash',
      tool_input: {
        command: 'gh pr merge 100 --merge',
        cwd: repoDir,
      },
    };
    const result = runGate({ payload, markerDir, repoDir });
    assert.equal(
      result.status,
      0,
      `Expected exit 0, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
    );
    const markerPath = path.join(markerDir, encodeURIComponent('feature/test-feat'));
    assert.equal(existsSync(markerPath), false);
    assert.equal(existsSync(path.join(markerDir, 'written')), false);
    assert.equal(existsSync(path.join(markerDir, 'scoped')), false);
  } finally {
    rmSync(markerDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  }
});
