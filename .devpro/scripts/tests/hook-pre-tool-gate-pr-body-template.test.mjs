/**
 * hook-pre-tool-gate-pr-body-template.test.mjs
 *
 * Tests for Gate 4c (PR body template lint block) in pre-tool-gate.mjs.
 *
 * The gate fires on `gh pr create --body-file <path>` (and `-F body=@<file>`)
 * and BLOCKs when `pre-pr-body-template-check.mjs` detects missing canonical
 * phrases or cost-override disclosure mismatch (fix-silent-gate-skip R7).
 * Generic lint keeps inline/unreadable fail-open behavior only for a positive
 * source repository; consumer and unknown repositories need a readable body for
 * the DEV deploy-verify line. Applicable consumer checks are enforced first for
 * supported literal create command positions.
 *
 * Mandatory phrases checked by pre-pr-body-template-check.mjs:
 *   - ## Test Evidence
 *   - ## Requirement Ledger Completion  (with disposition counts or N/A: <reason>)
 *   - ## Scenario Walkthrough
 *   - ## Cost Circuit Breaker Overrides
 *   - 驗收證據
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from './lib/tmp.mjs';
import { withChangeUsageStateDir } from './lib/change-usage-fixtures.mjs';
import { appendChangeUsageOverride } from '../hooks/lib/change-usage-checkpoint.mjs';
import { advisoryText } from './lib/hook-harness.mjs';
import { HOOK_BYPASS_HINT } from '../hooks/lib/hook-bypass.mjs';
// Direct format coverage below also selects .devpro/scripts/lib/consumer-pre-pr-gate.mjs changes.
import { consumerPrePrEvidenceError } from '../lib/consumer-pre-pr-gate.mjs';
import { PR_EVIDENCE_SECTION_MAX_BYTES } from '../lib/pr-body-evidence-rules.mjs';
import * as waiverCases from './lib/pr-waiver-two-path-cases.mjs';

const HOOK = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../hooks/pre-tool-gate.mjs'
);

// Consumer and unknown PRs carry exactly one DEV deploy-verify line in ## Test Evidence.
// Fixture line only; it is removed again where a test needs the missing-line case.
const DEV_FIXTURE_LINE = `- DEV deploy-verify: HEAD ${'0'.repeat(40)}; N/A: test fixture`;

// ── Canonical valid PR body (all mandatory phrases present) ────────────────

const VALID_PR_BODY = `
## OpenSpec
- change: \`openspec/changes/some-change/\`
- tasks.md: all checked

## Test Evidence
All tests pass. \`node .devpro/scripts/run-test-suite.mjs --tier all\` → 42 passed / 0 failed.
${DEV_FIXTURE_LINE}

## Change Context
- 改什麼：example landing
- 目的：example purpose

## Manual Test
- N/A: rule-only grep change; no human UI path

## Requirement Ledger Completion
- disposition counts: implemented 1, partial 0, deferred 0, rejected 0, moved-to-issue 0
- non-implemented rows: N/A

## Scenario Walkthrough
Hook fires on \`gh pr create --body-file\`. Body missing sections → block.

## Cost Circuit Breaker Overrides
- N/A

## 驗收證據
- 測試全綠（42 passed）
- Gate 4c body-file blocks on template/disclosure failure

Rules: v6.69.0 · Tool: Claude Code · Model: Sonnet 4.6
`.trim();

// Missing ## Scenario Walkthrough
const PR_BODY_MISSING_WALKTHROUGH = `
## OpenSpec
- change: \`openspec/changes/some-change/\`

## Test Evidence
All tests pass.
${DEV_FIXTURE_LINE}

## Change Context
- 改什麼：example landing
- 目的：example purpose

## Manual Test
- N/A: rule-only grep change; no human UI path

## Requirement Ledger Completion
- disposition counts: implemented 1, partial 0, deferred 0, rejected 0, moved-to-issue 0
- non-implemented rows: N/A

## 驗收證據
- 測試全綠

Rules: v6.69.0 · Tool: Claude Code · Model: Sonnet 4.6
`.trim();

// ── Helper utilities ───────────────────────────────────────────────────────

function runHook(payload, extraEnv = {}) {
  const result = spawnSync('node', [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_CI: '',
      CODEX_THREAD_ID: '',
      DEVPRO_SENTINEL_STATE_DIR: makeTempDir('sentinel-pr-body-test-'),
      ...extraEnv,
    },
  });
  let json = null;
  if (result.stdout && result.stdout.trim()) {
    try { json = JSON.parse(result.stdout); } catch { /* not JSON */ }
  }
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

function makeBodyRepo(prefix) {
  const repo = makeTempDir(prefix);
  evidenceGit(repo, ['init', '-q', '-b', 'chore/check-body']);
  evidenceGit(repo, ['commit', '--allow-empty', '-q', '--no-verify', '-m', 'init']);
  return repo;
}

// A positive source identity (origin + maintained-corpus sentinels). Consumer and
// unknown checkouts must carry a DEV deploy-verify line, so tests of the generic
// lint's inline/unreadable fail-open semantics run in a source checkout.
function makeSourceBodyRepo(prefix) {
  const repo = makeBodyRepo(prefix);
  mkdirSync(path.join(repo, '.devpro/agent-rules'), { recursive: true });
  mkdirSync(path.join(repo, '.devpro/scripts'), { recursive: true });
  writeFileSync(path.join(repo, '.devpro/agent-rules/rule-audit-playbook.md'), 'source');
  writeFileSync(path.join(repo, '.devpro/scripts/pre-pr-archive-gate.mjs'), 'source');
  evidenceGit(repo, ['remote', 'add', 'origin', 'https://example.invalid/devpro-agent-rules.git']);
  return repo;
}

// ── Tests ──────────────────────────────────────────────────────────────────

test('case 1 (PASS): gh pr create --body-file with all mandatory sections → no advisory, no block', () => {
  const tmpDir = makeBodyRepo('pr-body-gate-t1-');
  try {
    const bodyFile = path.join(tmpDir, 'pr-body.md');
    writeFileSync(bodyFile, VALID_PR_BODY, 'utf8');
    const cmd = `gh pr create --title "chore: some change" --body-file ${bodyFile}`;
    const payload = { tool_name: 'Bash', tool_input: { command: cmd, cwd: tmpDir } };
    const r = runHook(payload);
    assert.equal(r.code, 0, `Expected exit 0, got ${r.code}\nstderr: ${r.stderr}`);
    // Must not block.
    assert.ok(
      !r.json || r.json.decision !== 'block',
      `Should not block valid PR body\njson: ${JSON.stringify(r.json)}`
    );
    // Must not emit PR body template advisory.
    assert.ok(
      !advisoryText(r.json).includes('PR body template lint gate'),
      `Valid PR body should not emit advisory\ncontext: ${advisoryText(r.json)}`
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('case 2 (BLOCK): gh pr create --body-file missing ## Scenario Walkthrough → block', () => {
  const tmpDir = makeBodyRepo('pr-body-gate-t2-');
  try {
    const bodyFile = path.join(tmpDir, 'pr-body.md');
    writeFileSync(bodyFile, PR_BODY_MISSING_WALKTHROUGH, 'utf8');
    const cmd = `gh pr create --title "chore: some change" --body-file ${bodyFile}`;
    const payload = { tool_name: 'Bash', tool_input: { command: cmd, cwd: tmpDir } };
    const r = runHook(payload);
    assert.ok(r.json, `Expected JSON output, got: stdout=${r.stdout}`);
    assert.equal(r.json.decision, 'block',
      `PR body template gate must block
json: ${JSON.stringify(r.json)}`);
    const reason = r.json.reason || advisoryText(r.json);
    assert.ok(
      reason.includes('PR body template lint gate'),
      `Block reason should mention PR body template lint gate
context: ${reason}`
    );
    assert.ok(
      reason.includes('Scenario Walkthrough'),
      `Block reason should mention Scenario Walkthrough
context: ${reason}`
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('case 3 (fail-open): gh pr create --body "inline text" (no file) → no advisory, no block', () => {
  const tmpDir = makeSourceBodyRepo('pr-body-gate-t3-');
  try {
    // Inline --body without a file: gate must fail-open (skip, no advisory).
    const cmd = `gh pr create --title "chore: x" --body "inline body text without file"`;
    const payload = { tool_name: 'Bash', tool_input: { command: cmd, cwd: tmpDir } };
    const r = runHook(payload);
    assert.equal(r.code, 0, `Expected exit 0\nstderr: ${r.stderr}`);
    assert.ok(
      !r.json || r.json.decision !== 'block',
      `Inline body must not block\njson: ${JSON.stringify(r.json)}`
    );
    // Must not emit PR body template advisory (fail-open on inline body).
    assert.ok(
      !advisoryText(r.json).includes('PR body template lint gate'),
      `Inline body should not emit PR body lint advisory\ncontext: ${advisoryText(r.json)}`
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('case 4 (fail-open unreadable): gh pr create --body-file /nonexistent/path → no block', () => {
  const tmpDir = makeSourceBodyRepo('pr-body-gate-t4-');
  try {
    // Non-existent body file: gate must NOT block (fail-open semantics).
    // An "unreadable" advisory is acceptable but must never be a block.
    const cmd = `gh pr create --title "chore: x" --body-file /nonexistent/path/pr-body.md`;
    const payload = { tool_name: 'Bash', tool_input: { command: cmd, cwd: tmpDir } };
    const r = runHook(payload);
    assert.equal(r.code, 0, `Expected exit 0\nstderr: ${r.stderr}`);
    assert.ok(
      !r.json || r.json.decision !== 'block',
      `Unreadable body file must not block\njson: ${JSON.stringify(r.json)}`
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('case 5 (BLOCK via -F body=@<file>): gh pr create -F body=@<tmpfile> missing ## Scenario Walkthrough → block', () => {
  // Verifies BODY_FILE_RE group 2 (@<path> form) is correctly extracted by
  // checkPrBodyTemplateLint and triggers lint when a mandatory section is missing.
  const tmpDir = makeSourceBodyRepo('pr-body-gate-t5-');
  try {
    const bodyFile = path.join(tmpDir, 'pr-body.md');
    writeFileSync(bodyFile, PR_BODY_MISSING_WALKTHROUGH, 'utf8');
    // Use `-F body=@<path>` form (BODY_FILE_RE group 2) instead of --body-file.
    const cmd = `gh pr create --title "x" -F body=@${bodyFile}`;
    const payload = { tool_name: 'Bash', tool_input: { command: cmd, cwd: tmpDir } };
    const r = runHook(payload);
    assert.ok(r.json, `Expected JSON output, got: stdout=${r.stdout}`);
    assert.equal(r.json.decision, 'block',
      `PR body template gate must block
json: ${JSON.stringify(r.json)}`);
    const reason = r.json.reason || advisoryText(r.json);
    assert.ok(
      reason.includes('PR body template lint gate'),
      `Block reason should mention PR body template lint gate
context: ${reason}`
    );
    assert.ok(
      reason.includes('Scenario Walkthrough'),
      `Block reason should mention Scenario Walkthrough
context: ${reason}`
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('case 6 (segment-filter trigger-skip): `gh pr create` only inside a heredoc body does NOT fire the gate', () => {
  // Trigger detection runs through gateCommandSegmentText, which strips heredoc
  // bodies. A `gh pr create` mention that lives ONLY inside a heredoc (e.g. a
  // Recap discussion body documenting a PR-create example) must NOT fire the
  // PR-body lint — the outer command here is `gh api graphql`, not a real
  // `gh pr create`. Mirrors the segment-filter contract the spec scenario pins.
  const tmpDir = makeBodyRepo('pr-body-gate-t6-');
  try {
    const cmd = [
      'gh api graphql -F body=@- <<\'EOF\'',
      '## Recap',
      'Example: run `gh pr create --title "x" --body-file body.md` to open the PR.',
      'EOF',
    ].join('\n');
    const payload = { tool_name: 'Bash', tool_input: { command: cmd, cwd: tmpDir } };
    const r = runHook(payload);
    assert.equal(r.code, 0, `Expected exit 0\nstderr: ${r.stderr}`);
    assert.ok(
      !r.json || r.json.decision !== 'block',
      `Heredoc-only gh pr create must not block\njson: ${JSON.stringify(r.json)}`
    );
    // The PR-body gate must not fire at all (the create mention is filtered out).
    assert.ok(
      !advisoryText(r.json).includes('PR body template lint gate'),
      `gh pr create inside a heredoc should not fire the PR-body gate\ncontext: ${advisoryText(r.json)}`
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('case 7 (raw extraction in compound command): body file after `cd ... &&` is still captured', () => {
  // Body-file-path extraction runs against the RAW command string, not the
  // segment-filtered text, so a real `gh pr create` whose --body-file argument
  // sits after other segments in a compound command is still captured + linted.
  // The body is missing ## Scenario Walkthrough, so a passing extraction yields
  // an advisory; a broken (segment-only) extraction would silently skip it.
  const tmpDir = makeBodyRepo('pr-body-gate-t7-');
  try {
    const bodyFile = path.join(tmpDir, 'pr-body.md');
    writeFileSync(bodyFile, PR_BODY_MISSING_WALKTHROUGH, 'utf8');
    // Absolute --body-file path so resolution is cwd-independent; the `cd &&`
    // prefix exercises the compound-command shape from the spec scenario.
    const cmd = `cd ${tmpDir} && gh pr create --title "chore: x" --body-file ${bodyFile}`;
    const payload = { tool_name: 'Bash', tool_input: { command: cmd, cwd: tmpDir } };
    const r = runHook(payload);
    assert.ok(r.json, `Expected JSON output, got: stdout=${r.stdout}`);
    assert.equal(r.json.decision, 'block',
      `PR body template gate must block
json: ${JSON.stringify(r.json)}`);
    const reason = r.json.reason || advisoryText(r.json);
    assert.ok(
      reason.includes('PR body template lint gate'),
      `Block reason should mention PR body template lint gate
context: ${reason}`
    );
    assert.ok(
      reason.includes('Scenario Walkthrough'),
      `Block reason should mention Scenario Walkthrough
context: ${reason}`
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('case 8 (-F <path> shorthand): bare `gh pr create -F <file>` is captured (gh --body-file alias)', () => {
  // `-F` is gh's official short alias for `--body-file` (gh pr create --help:
  // `-F, --body-file file`). A bare `-F <path>` (no `key=value`) is the natural
  // create shorthand and MUST be linted just like --body-file — otherwise an
  // agent using `gh pr create -F .pr-body.md` silently skips the advisory.
  const tmpDir = makeBodyRepo('pr-body-gate-t8-');
  try {
    const bodyFile = path.join(tmpDir, 'pr-body.md');
    writeFileSync(bodyFile, PR_BODY_MISSING_WALKTHROUGH, 'utf8');
    const cmd = `gh pr create --title "chore: x" -F ${bodyFile}`;
    const payload = { tool_name: 'Bash', tool_input: { command: cmd, cwd: tmpDir } };
    const r = runHook(payload);
    assert.ok(r.json, `Expected JSON output, got: stdout=${r.stdout}`);
    assert.equal(r.json.decision, 'block',
      `PR body template gate must block
json: ${JSON.stringify(r.json)}`);
    const reason = r.json.reason || advisoryText(r.json);
    assert.ok(
      reason.includes('PR body template lint gate'),
      `Block reason should mention PR body template lint gate
context: ${reason}`
    );
    assert.ok(
      reason.includes('Scenario Walkthrough'),
      `Block reason should mention Scenario Walkthrough
context: ${reason}`
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('case 9 (regression: -F key=value not mis-read as path): `gh pr create -F body=@<file>` still routes via BODY_FILE_RE', () => {
  // Guards the PR_BODY_FILE_FLAG_RE negative-lookahead boundary: the `gh api`
  // raw-field form `-F body=@<file>` (a key=value field) must NOT be captured by
  // the bare `-F <path>` alternative — it stays with BODY_FILE_RE. The path is
  // `<file>`, not the literal `body=@<file>`, so the lint still finds the body.
  const tmpDir = makeSourceBodyRepo('pr-body-gate-t9-');
  try {
    const bodyFile = path.join(tmpDir, 'pr-body.md');
    writeFileSync(bodyFile, PR_BODY_MISSING_WALKTHROUGH, 'utf8');
    const cmd = `gh pr create --title "x" -F body=@${bodyFile}`;
    const payload = { tool_name: 'Bash', tool_input: { command: cmd, cwd: tmpDir } };
    const r = runHook(payload);
    assert.ok(r.json, `Expected JSON output, got: stdout=${r.stdout}`);
    assert.equal(r.json.decision, 'block',
      `PR body template gate must block\njson: ${JSON.stringify(r.json)}`);
    const reason = r.json.reason || advisoryText(r.json);
    assert.ok(
      reason.includes('PR body template lint gate') && reason.includes(bodyFile),
      `-F body=@<file> must route via BODY_FILE_RE to the real path\ncontext: ${reason}`
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('case 10 (FP): inline --body text mentioning --body-file is not treated as a carrier', () => {
  const tmpDir = makeSourceBodyRepo('pr-body-gate-t10-');
  try {
    const ghost = path.join(tmpDir, 'missing-pr-body.md');
    const cmd =
      `gh pr create --title "chore: x" ` +
      `--body "Documented example: gh pr create --body-file ${ghost}"`;
    const payload = { tool_name: 'Bash', tool_input: { command: cmd, cwd: tmpDir } };
    const r = runHook(payload);
    assert.equal(r.code, 0, `Expected exit 0\nstderr: ${r.stderr}`);
    assert.ok(
      !r.json || r.json.decision !== 'block',
      `Inline body example must not block\njson: ${JSON.stringify(r.json)}`
    );
    const advisory = advisoryText(r.json);
    assert.ok(
      !advisory.includes('PR body file unreadable') &&
        !advisory.includes('PR body template lint gate'),
      `Quoted --body-file text must not be read as a file carrier\ncontext: ${advisory}`
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('case 11 (FP): inline --body text mentioning -F body=@file is not treated as a carrier', () => {
  const tmpDir = makeSourceBodyRepo('pr-body-gate-t11-');
  try {
    const ghost = path.join(tmpDir, 'missing-pr-body.md');
    const cmd =
      `gh pr create --title "chore: x" ` +
      `--body "Documented example: gh api graphql -F body=@${ghost}"`;
    const payload = { tool_name: 'Bash', tool_input: { command: cmd, cwd: tmpDir } };
    const r = runHook(payload);
    assert.equal(r.code, 0, `Expected exit 0\nstderr: ${r.stderr}`);
    assert.ok(
      !r.json || r.json.decision !== 'block',
      `Inline body example must not block\njson: ${JSON.stringify(r.json)}`
    );
    const advisory = advisoryText(r.json);
    assert.ok(
      !advisory.includes('PR body file unreadable') &&
        !advisory.includes('PR body template lint gate'),
      `Quoted -F body=@ text must not be read as a file carrier\ncontext: ${advisory}`
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});


test('fix-silent-gate-skip R7: gh pr create --body-file with overrides[] vs N/A → block', () => {
  withChangeUsageStateDir(() => {
    const changeName = 'silent-gate-pr-create-block';
    const tmpDir = makeTempDir('pr-body-r7-');
    try {
      spawnSync('git', ['init', '-q', '-b', `bugfix/${changeName}`], { cwd: tmpDir, encoding: 'utf8' });
      spawnSync('git', ['config', 'user.email', 't@t.com'], { cwd: tmpDir, encoding: 'utf8' });
      spawnSync('git', ['config', 'user.name', 't'], { cwd: tmpDir, encoding: 'utf8' });
      spawnSync('git', ['commit', '--allow-empty', '-q', '-m', 'init'], { cwd: tmpDir, encoding: 'utf8' });
      mkdirSync(path.join(tmpDir, 'openspec', 'changes', changeName), { recursive: true });
      appendChangeUsageOverride({
        cwd: tmpDir,
        changeName,
        session_id: 's1',
        at: '2026-01-01T00:00:00.000Z',
        thresholds: ['output'],
        head_ref_oid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      });
      const bodyFile = path.join(tmpDir, 'pr-body.md');
      writeFileSync(bodyFile, VALID_PR_BODY, 'utf8');
      const cmd = `gh pr create --title "chore: x" --body-file ${bodyFile}`;
      const payload = { tool_name: 'Bash', tool_input: { command: cmd, cwd: tmpDir } };
      const r = runHook(payload);
      assert.ok(r.json, `Expected JSON output, got: stdout=${r.stdout}`);
      assert.equal(
        r.json.decision,
        'block',
        `expected block on disclosure mismatch; json=${JSON.stringify(r.json)} stderr=${r.stderr}`
      );
      const reason = r.json.reason || advisoryText(r.json);
      assert.match(reason, /PR body template lint gate|Cost Circuit Breaker|override/i);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── Evidence-section checks through the hook (strengthen-pre-pr-evidence-section-lint) ──
//
// The lint blocks only a PR that will be sent for a second opinion, so these cases build a temporary git repo
// on a feature branch: one base commit (origin/main points at it), one change commit, and a remote-tracking
// ref equal to local HEAD. Every non-blocking case below differs from the blocking one in a single condition.

const EVIDENCE_GIT_ENV = {
  ...process.env,
  // Git for Windows accepts its POSIX null path, not Node's device namespace.
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'tester',
  GIT_AUTHOR_EMAIL: 'tester.local',
  GIT_COMMITTER_NAME: 'tester',
  GIT_COMMITTER_EMAIL: 'tester.local',
};
const EVIDENCE_BRANCH = 'feature/evidence-hook-case';

function evidenceGit(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: EVIDENCE_GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeEvidenceRepo({ remoteTracking = true, branch = EVIDENCE_BRANCH, origin = false } = {}) {
  const cwd = makeTempDir('pr-body-gate-evidence-repo-');
  evidenceGit(cwd, ['init', '-q', '-b', 'main']);
  // A local bare repository stands in for origin: it has no branches, so ls-remote answers "no such branch".
  if (origin) {
    const bare = makeTempDir('pr-body-gate-evidence-origin-');
    evidenceGit(bare, ['init', '-q', '--bare']);
    evidenceGit(cwd, ['remote', 'add', 'origin', bare]);
  }
  evidenceGit(cwd, ['commit', '--allow-empty', '-q', '--no-verify', '-m', 'base']);
  evidenceGit(cwd, ['update-ref', 'refs/remotes/origin/main', evidenceGit(cwd, ['rev-parse', 'HEAD'])]);
  evidenceGit(cwd, ['checkout', '-q', '-b', branch]);
  writeFileSync(path.join(cwd, 'feature.txt'), 'feature\n', 'utf8');
  evidenceGit(cwd, ['add', '--', 'feature.txt']);
  evidenceGit(cwd, ['commit', '-q', '--no-verify', '-m', 'change']);
  if (remoteTracking) evidenceGit(cwd, ['update-ref', `refs/remotes/origin/${branch}`, evidenceGit(cwd, ['rev-parse', 'HEAD'])]);
  return cwd;
}

// VALID_PR_BODY with its Test Evidence text replaced by filler so the section measures `bytes` bytes.
// The DEV fixture line stays in the section, so the filler leaves room for it and its newline.
function bodyWithTestEvidenceBytes(bytes) {
  const filler = 'x'.repeat(bytes - Buffer.byteLength(DEV_FIXTURE_LINE) - 1);
  return VALID_PR_BODY.replace(/## Test Evidence\n[^\n]*\n/, `## Test Evidence\n${filler}\n`);
}

function runEvidenceHook({ createFlags = '', prefix = '', bytes = PR_EVIDENCE_SECTION_MAX_BYTES + 1, repoOptions } = {}) {
  const repo = makeEvidenceRepo(repoOptions);
  const bodyDir = makeTempDir('pr-body-gate-evidence-body-');
  try {
    const bodyFile = path.join(bodyDir, 'pr-body.md');
    writeFileSync(bodyFile, bodyWithTestEvidenceBytes(bytes), 'utf8');
    const cmd = `${prefix}gh pr create --title "feat: x" ${createFlags} --body-file ${bodyFile}`;
    const r = runHook({ tool_name: 'Bash', tool_input: { command: cmd, cwd: repo } });
    return { ...r, bodyFile };
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(bodyDir, { recursive: true, force: true });
  }
}

const assertNotBlocked = (r, label) => {
  assert.equal(r.code, 0, `${label}: expected exit 0\nstderr: ${r.stderr}`);
  assert.ok(!r.json || r.json.decision !== 'block', `${label}: must not block\njson: ${JSON.stringify(r.json)}`);
};

const assertConsumerTargetBlocked = (r, label) => {
  assert.equal(r.json?.decision, 'block', `${label}: ${r.stdout}`);
  assert.match(r.json.reason, /Consumer pre-PR checks gate/);
  assert.match(r.json.reason, /--body-file <absolute-body-file>/);
};

test('Scenario: Evidence section over the byte limit blocks before PR creation (through the hook)', () => {
  const r = runEvidenceHook();
  assert.ok(r.json, `Expected JSON output, got: stdout=${r.stdout}`);
  assert.equal(r.json.decision, 'block', `json: ${JSON.stringify(r.json)}`);
  const reason = r.json.reason || advisoryText(r.json);
  assert.ok(reason.includes('PR body template lint gate'), reason);
  assert.ok(reason.includes(r.bodyFile), 'the reason names the body file');
  assert.ok(reason.includes('## Test Evidence'), reason);
  assert.ok(reason.includes(`${PR_EVIDENCE_SECTION_MAX_BYTES + 1} UTF-8 bytes; limit ${PR_EVIDENCE_SECTION_MAX_BYTES}`), reason);
  assert.ok(reason.includes('## Supplementary Evidence'), reason);
  assert.ok(reason.trimEnd().endsWith(HOOK_BYPASS_HINT), `the reason ends with the hook bypass hint\n${reason}`);
  // The same body at exactly the limit is not blocked.
  assertNotBlocked(runEvidenceHook({ bytes: PR_EVIDENCE_SECTION_MAX_BYTES }), 'body at the limit');
});

test('Scenario: Exempt evidence checks pass but unresolved consumer targets block (through the hook)', () => {
  // --head naming the local branch still blocks on generic evidence; an unresolved foreign head blocks applicability.
  assert.equal(runEvidenceHook({ createFlags: `--head ${EVIDENCE_BRANCH}` }).json?.decision, 'block');
  assertConsumerTargetBlocked(runEvidenceHook({ createFlags: '--head some-other-branch' }), '--head differs from the local branch');
  assertConsumerTargetBlocked(runEvidenceHook({ createFlags: '--head fork-owner:some-other-branch' }), 'fork form --head');
  // A head or base that cannot be read literally is unresolved, never silently replaced by the default.
  assertConsumerTargetBlocked(runEvidenceHook({ createFlags: '--head "$HEAD_BRANCH"' }), 'non-literal --head');
  assertNotBlocked(runEvidenceHook({ createFlags: '--base "$BASE_BRANCH"' }), 'non-literal --base');
  // A literal --base is forwarded: a resolvable one still blocks, an unknown one skips the check.
  assert.equal(runEvidenceHook({ createFlags: '--base main' }).json?.decision, 'block');
  assertNotBlocked(runEvidenceHook({ createFlags: '--base no-such-base' }), 'literal --base that does not resolve');
  // A branch switch earlier in the same command means the checked-out branch is not the PR head.
  assertConsumerTargetBlocked(runEvidenceHook({ prefix: `git checkout ${EVIDENCE_BRANCH} && ` }), 'branch switch earlier in the command');
});

test('Scenario: Remote branch not proven to match local HEAD is not blocked (through the hook)', () => {
  assertNotBlocked(runEvidenceHook({ repoOptions: { remoteTracking: false } }), 'no remote-tracking ref');
});

test('Scenario: A branch that origin does not have yet is checked against local HEAD (through the hook)', () => {
  const firstPr = { remoteTracking: false, origin: true };
  // A plain gh pr create, and a push that has not run yet followed by gh pr create: origin has no such branch.
  for (const prefix of ['', `git push -u origin ${EVIDENCE_BRANCH} && `]) {
    const r = runEvidenceHook({ repoOptions: firstPr, prefix });
    assert.ok(r.json, `Expected JSON output for prefix [${prefix}], got: stdout=${r.stdout} stderr=${r.stderr}`);
    assert.equal(r.json.decision, 'block', `prefix [${prefix}] json: ${JSON.stringify(r.json)}`);
    const reason = r.json.reason || advisoryText(r.json);
    assert.ok(reason.includes('PR body template lint gate'), reason);
    assert.ok(reason.includes('## Test Evidence'), reason);
  }
  // Same first PR, but within the limits, or an exempt chore branch: not blocked.
  assertNotBlocked(runEvidenceHook({ repoOptions: firstPr, bytes: PR_EVIDENCE_SECTION_MAX_BYTES }), 'first PR within the limit');
  assertNotBlocked(
    runEvidenceHook({ repoOptions: { ...firstPr, branch: 'chore/tidy-notes' } }),
    'first PR on an exempt chore branch',
  );
});

// ── The PR belongs to the checkout the command changes into, not to the session cwd ──
//
// Each case below has two pushed checkouts: the session cwd and the directory a leading `cd` moves into. The
// feature checkout needs a second opinion; the chore checkout (no proposal file in its diff) is exempt.

const FEATURE_OPTIONS = { branch: 'feature/needs-second-review' };
const CHORE_OPTIONS = { branch: 'chore/tidy-notes' };

function runAcrossCheckouts({ session, target, buildPrefix, suffix = '', body = bodyWithTestEvidenceBytes(PR_EVIDENCE_SECTION_MAX_BYTES + 1) }) {
  const sessionRepo = makeEvidenceRepo(session);
  const targetRepo = target ? makeEvidenceRepo(target) : sessionRepo;
  const bodyDir = makeTempDir('pr-body-gate-evidence-body-');
  try {
    const bodyFile = path.join(bodyDir, 'pr-body.md');
    writeFileSync(bodyFile, body, 'utf8');
    const cmd = `${buildPrefix(targetRepo)}gh pr create --title "feat: x" --body-file ${bodyFile}${suffix}`;
    return runHook({ tool_name: 'Bash', tool_input: { command: cmd, cwd: sessionRepo } });
  } finally {
    rmSync(sessionRepo, { recursive: true, force: true });
    if (target) rmSync(targetRepo, { recursive: true, force: true });
    rmSync(bodyDir, { recursive: true, force: true });
  }
}

const cdTo = (repo) => `cd ${repo} && `;

test('Scenario: A cd to an exempt checkout is not blocked by the evidence checks (through the hook)', () => {
  // Control: the same over-limit body blocks when the command stays in the pushed feature checkout.
  const control = runAcrossCheckouts({ session: FEATURE_OPTIONS, buildPrefix: () => '' });
  assert.equal(control.json?.decision, 'block', `control must block\njson: ${JSON.stringify(control.json)}`);
  // The PR comes from the chore checkout the command changes into, so it is exempt.
  assertNotBlocked(
    runAcrossCheckouts({ session: FEATURE_OPTIONS, target: CHORE_OPTIONS, buildPrefix: cdTo }),
    'cd into an exempt chore checkout',
  );
});

test('Scenario: A cd to a checkout that needs second review is blocked by the evidence checks (through the hook)', () => {
  // The session checkout is exempt; the PR comes from the feature checkout the command changes into.
  const r = runAcrossCheckouts({ session: CHORE_OPTIONS, target: FEATURE_OPTIONS, buildPrefix: cdTo });
  assert.ok(r.json, `Expected JSON output, got: stdout=${r.stdout}`);
  assert.equal(r.json.decision, 'block', `json: ${JSON.stringify(r.json)}`);
  const reason = r.json.reason || advisoryText(r.json);
  assert.ok(reason.includes('PR body template lint gate'), reason);
  assert.ok(reason.includes('## Test Evidence'), reason);
  assert.ok(reason.includes('branch=feature/needs-second-review'), `the finding names the checkout the PR comes from\n${reason}`);
});

// ── #3556 item 2: DEVPRO_PR_CHECKOUT names the PR checkout without `cd` ──
//
// gh has no `-C`, so a session in one repository names the local checkout of a PR for another repository with a
// command-local `DEVPRO_PR_CHECKOUT=<absolute path>`. Every gh pr create gate then reads that checkout. The prefix
// needs a literal --repo/-R and --head too: gh itself still runs in the session cwd.
function runDeclaredCheckout({ session, target, flags, prefix = (repo) => `DEVPRO_PR_CHECKOUT=${repo} `, body = bodyWithTestEvidenceBytes(PR_EVIDENCE_SECTION_MAX_BYTES + 1), bodyArg = (file) => `--body-file ${file}`, env = {} }) {
  const sessionRepo = makeEvidenceRepo(session);
  const targetRepo = makeEvidenceRepo(target);
  evidenceGit(sessionRepo, ['remote', 'add', 'origin', 'https://github.com/acme/session.git']);
  evidenceGit(targetRepo, ['remote', 'add', 'origin', 'https://github.com/acme/target.git']);
  const bodyDir = makeTempDir('pr-body-gate-declared-body-');
  try {
    const bodyFile = path.join(bodyDir, 'pr-body.md');
    writeFileSync(bodyFile, body, 'utf8');
    const cmd = `${prefix(targetRepo)}gh pr create --title "feat: x" ${flags(targetRepo)} ${bodyArg(bodyFile)}`;
    return runHook({ tool_name: 'Bash', tool_input: { command: cmd, cwd: sessionRepo } }, env);
  } finally {
    rmSync(sessionRepo, { recursive: true, force: true });
    rmSync(targetRepo, { recursive: true, force: true });
    rmSync(bodyDir, { recursive: true, force: true });
  }
}

test('#3556 DEVPRO_PR_CHECKOUT: the gates read the declared checkout instead of the session cwd (through the hook)', () => {
  const chore = () => `-R acme/target --head ${CHORE_OPTIONS.branch}`;
  // Control: without the prefix the session checkout does not match -R.
  const control = runDeclaredCheckout({ session: FEATURE_OPTIONS, target: CHORE_OPTIONS, flags: chore, prefix: () => '' });
  assert.equal(control.json?.decision, 'block', JSON.stringify(control.json));
  // add-cross-repo-pr-scope-marker: an unmarked cross-repo create is now blocked by the earlier Cross-repo PR write gate.
  assert.match(control.json.reason, /^Cross-repo PR write gate/);
  assert.match(control.json.reason, /DEVPRO_PR_CHECKOUT=<absolute[- ]checkout>/, 'the hint names the declared-checkout form');
  // The declared exempt chore checkout passes, as the cd form does.
  assertNotBlocked(runDeclaredCheckout({ session: FEATURE_OPTIONS, target: CHORE_OPTIONS, flags: chore }), 'declared exempt checkout');
  // The declared feature checkout is the one the evidence lint reads.
  const feature = runDeclaredCheckout({ session: CHORE_OPTIONS, target: FEATURE_OPTIONS, flags: () => `-R acme/target --head ${FEATURE_OPTIONS.branch}` });
  assert.equal(feature.json?.decision, 'block', JSON.stringify(feature.json));
  assert.match(feature.json.reason, /PR body template lint gate/);
  assert.match(feature.json.reason, /branch=feature\/needs-second-review/);
});

test('#3556 DEVPRO_PR_CHECKOUT: the prefix needs a literal checkout, --repo/-R of it and a literal --head (through the hook)', () => {
  const declared = (flags, prefix) => runDeclaredCheckout({ session: FEATURE_OPTIONS, target: CHORE_OPTIONS, flags, prefix });
  const notGit = makeTempDir('pr-body-gate-not-a-checkout-');
  const cases = [
    ['no --repo/-R', () => `--head ${CHORE_OPTIONS.branch}`, undefined, /DEVPRO_PR_CHECKOUT also needs --repo\/-R/],
    ['no --head', () => '-R acme/target', undefined, /DEVPRO_PR_CHECKOUT also needs a literal --head/],
    // add-cross-repo-pr-scope-marker: a declared checkout whose origin is not --repo is now blocked by the earlier
    // Cross-repo PR write gate, which also says the marker does not relax a declared checkout.
    ['--repo of another repository', () => `-R acme/session --head ${CHORE_OPTIONS.branch}`, undefined, /marker does not relax a declared checkout: the declared checkout is acme\/target, so declare a checkout of acme\/session instead/, /^Cross-repo PR write gate/],
    ['--head without a worktree in that repository', () => '-R acme/target --head feature/missing', undefined, /--head does not identify a checked-out local worktree/],
    ['relative checkout', () => `-R acme/target --head ${CHORE_OPTIONS.branch}`, () => 'DEVPRO_PR_CHECKOUT=relative/dir ', /literal absolute path/],
    ['variable checkout', () => `-R acme/target --head ${CHORE_OPTIONS.branch}`, () => 'DEVPRO_PR_CHECKOUT=$TARGET ', /literal absolute path/],
    ['not a git checkout', () => `-R acme/target --head ${CHORE_OPTIONS.branch}`, () => `DEVPRO_PR_CHECKOUT=${notGit} `, /is not a git checkout/],
  ];
  for (const [label, flags, prefix, reason, gate = /^Consumer pre-PR checks gate: /] of cases) {
    const r = declared(flags, prefix);
    assert.equal(r.json?.decision, 'block', `${label}: ${JSON.stringify(r.json)}`);
    assert.match(r.json.reason, gate, label);
    assert.match(r.json.reason, reason, label);
  }
  rmSync(notGit, { recursive: true, force: true });
});

// gh still runs in the session cwd, so the declared form names its repository and body file explicitly (cross-review F1/F2).
test('#3556 DEVPRO_PR_CHECKOUT: an inherited GH_REPO does not stand in for --repo/-R, and a relative --body-file is refused (through the hook)', () => {
  const head = `--head ${CHORE_OPTIONS.branch}`;
  const inherited = runDeclaredCheckout({ session: FEATURE_OPTIONS, target: CHORE_OPTIONS, flags: () => head, env: { GH_REPO: 'acme/target' } });
  assert.equal(inherited.json?.decision, 'block', JSON.stringify(inherited.json));
  assert.match(inherited.json.reason, /DEVPRO_PR_CHECKOUT also needs --repo\/-R/);
  const relative = runDeclaredCheckout({ session: FEATURE_OPTIONS, target: CHORE_OPTIONS, flags: () => `-R acme/target ${head}`, bodyArg: (file) => `--body-file ${path.basename(file)}` });
  assert.equal(relative.json?.decision, 'block', JSON.stringify(relative.json));
  assert.match(relative.json.reason, /a --body-file with DEVPRO_PR_CHECKOUT must be an absolute path/);
  // Control: the explicit form with an absolute body file still passes for the exempt checkout.
  assertNotBlocked(runDeclaredCheckout({ session: FEATURE_OPTIONS, target: CHORE_OPTIONS, flags: () => `-R acme/target ${head}`, env: { GH_REPO: 'acme/target' } }), 'explicit --repo with GH_REPO set');
  // Only a body file is read from a path: an inline body and stdin carry the same text to the checks and to gh.
  for (const [label, bodyArg] of [['inline --body', () => '--body "Adds the example."'], ['stdin -F -', () => '-F -']]) {
    const r = runDeclaredCheckout({ session: FEATURE_OPTIONS, target: CHORE_OPTIONS, flags: () => `-R acme/target ${head}`, bodyArg });
    assert.doesNotMatch(r.json?.reason ?? '', /must be an absolute path/, label);
  }
});

test('#3556 consumer checks: a --repo/-R written as a shell variable names that cause (through the hook)', () => {
  for (const flag of ['-R $REPO', '--repo "$REPO"', '--repo=$(cat repo-name)']) {
    const r = runDeclaredCheckout({ session: FEATURE_OPTIONS, target: CHORE_OPTIONS, flags: () => `${flag} --head ${CHORE_OPTIONS.branch}` });
    assert.equal(r.json?.decision, 'block', `${flag}: ${JSON.stringify(r.json)}`);
    // add-cross-repo-pr-scope-marker: a shell-expanded --repo is now blocked by the earlier Cross-repo PR write gate,
    // which asks for the literal [HOST/]OWNER/REPO.
    assert.match(r.json.reason, /^Cross-repo PR write gate/, flag);
    assert.match(r.json.reason, /literal \[HOST\/\]OWNER\/REPO/, flag);
  }
});

test('Scenario: An unresolvable cwd blocks consumer applicability before generic evidence checks (through the hook)', () => {
  // Prefixes the gate cannot resolve statically: a variable operand, and a directory that does not exist.
  const prefixes = [
    () => 'cd "$SOME_VAR" && ',
    () => 'cd /nonexistent-dir-for-pr-body-gate-test && ',
  ];
  for (const buildPrefix of prefixes) {
    assertConsumerTargetBlocked(
      runAcrossCheckouts({ session: FEATURE_OPTIONS, buildPrefix }),
      `over-limit evidence with an unresolvable cwd (${buildPrefix()})`,
    );
    // Consumer target safety runs first, including when the generic body has a missing section.
    const missing = runAcrossCheckouts({ session: FEATURE_OPTIONS, buildPrefix, body: PR_BODY_MISSING_WALKTHROUGH });
    assert.equal(missing.json?.decision, 'block', `missing section must still block (${buildPrefix()})\njson: ${JSON.stringify(missing.json)}`);
    assert.ok((missing.json.reason || '').includes('Consumer pre-PR checks gate'), missing.json.reason);
  }
});

test('evidence checks through the hook: a cd to the session cwd itself behaves like no cd', () => {
  const sameDir = (repo) => cdTo(repo);
  const blocks = runAcrossCheckouts({ session: FEATURE_OPTIONS, buildPrefix: sameDir });
  assert.equal(blocks.json?.decision, 'block', `feature checkout must still block\njson: ${JSON.stringify(blocks.json)}`);
  assertNotBlocked(runAcrossCheckouts({ session: CHORE_OPTIONS, buildPrefix: sameDir }), 'cd to the exempt session checkout');
});

test('evidence checks through the hook: the PR checkout is the cwd where gh pr create runs, not where the first git command runs', () => {
  // `git -C <dir>` does not move the shell, so the PR still comes from the session checkout (exempt chore here).
  assertNotBlocked(
    runAcrossCheckouts({ session: CHORE_OPTIONS, target: FEATURE_OPTIONS, buildPrefix: (repo) => `git -C ${repo} status && ` }),
    'git -C into a feature checkout does not move gh pr create',
  );
  // A `cd` that comes after an earlier git command still moves the shell before gh pr create runs.
  const moved = runAcrossCheckouts({
    session: CHORE_OPTIONS,
    target: FEATURE_OPTIONS,
    buildPrefix: (repo) => `git status && cd ${repo} && `,
  });
  assert.equal(moved.json?.decision, 'block', `a later cd into the feature checkout must block\njson: ${JSON.stringify(moved.json)}`);
  assert.ok((moved.json.reason || '').includes('branch=feature/needs-second-review'), moved.json.reason);
});

// Text that merely contains `gh pr create` or an opening parenthesis before the real command: a quoted string, a
// comment line, a plain argument, a heredoc body. None of them is the command or a subshell, so the checkout is the one
// the real `gh pr create` runs in.
const DECOY_PREFIXES = [
  ['a quoted string', (repo) => `echo "gh pr create" && cd ${repo} && `],
  ['a git log --grep argument', (repo) => `git log --grep "gh pr create" -1 && cd ${repo} && `],
  ['a comment line', (repo) => `# run gh pr create next\ncd ${repo} && `],
  ['a plain argument', (repo) => `echo gh pr create && cd ${repo} && `],
  // The words sit right after a command-position boundary character, so only the segment check can reject them.
  ['a quoted string holding a boundary character', (repo) => `echo "a && gh pr create" && cd ${repo} && `],
  ['a comment holding a boundary character', (repo) => `# a; gh pr create\ncd ${repo} && `],
  ['the first line of a heredoc body', (repo) => `cat <<'EOF' > /dev/null\ngh pr create --fill\nEOF\ncd ${repo} && `],
  // An opening parenthesis in text that is data, not a subshell: only the data-region exclusion keeps it from reading as one.
  ['a quoted string holding a parenthesis', (repo) => `echo "(x)" && cd ${repo} && `],
  ['a commit message holding a parenthesis', (repo) => `git commit -m "feat(lint): x" && cd ${repo} && `],
  ['a heredoc body line holding a parenthesis', (repo) => `cat <<'EOF' > /dev/null\nsee (x)\nEOF\ncd ${repo} && `],
];

test('Scenario: A gh pr create mention inside a string, comment or argument does not set the checkout (through the hook, feature checkout blocks)', () => {
  for (const [label, buildPrefix] of DECOY_PREFIXES) {
    const r = runAcrossCheckouts({ session: CHORE_OPTIONS, target: FEATURE_OPTIONS, buildPrefix });
    assert.equal(r.json?.decision, 'block', `${label} before the real command must not hide the feature checkout\njson: ${JSON.stringify(r.json)}`);
    assert.ok((r.json.reason || '').includes('branch=feature/needs-second-review'), `${label}\n${r.json.reason}`);
  }
});

test('Scenario: A gh pr create mention inside a string, comment or argument does not set the checkout (through the hook, exempt checkout not blocked)', () => {
  for (const [label, buildPrefix] of DECOY_PREFIXES) {
    assertNotBlocked(
      runAcrossCheckouts({ session: FEATURE_OPTIONS, target: CHORE_OPTIONS, buildPrefix }),
      `${label} before the real command must not make the exempt checkout look like the session feature checkout`,
    );
  }
});

const READABLE_ENV_PREFIXES = [
  ['a literal', 'GH_TOKEN=token '],
  ['a variable', 'GH_TOKEN=$TOKEN '],
  ['a braced variable', 'GH_TOKEN=${TOKEN} '],
];

test('Scenario: A readable environment value before gh pr create keeps the checkout (through the hook)', () => {
  for (const [label, prefix] of READABLE_ENV_PREFIXES) {
    const blocked = runAcrossCheckouts({ session: FEATURE_OPTIONS, buildPrefix: () => prefix });
    assert.equal(blocked.json?.decision, 'block', `${label}: the same body that blocks a plain command must block\njson: ${JSON.stringify(blocked.json)}`);
    assert.ok((blocked.json.reason || '').includes('branch=feature/needs-second-review'), `${label}\n${blocked.json.reason}`);
    assertNotBlocked(runAcrossCheckouts({ session: CHORE_OPTIONS, buildPrefix: () => prefix }), `${label}, exempt checkout`);
  }
});

test('Scenario: An unreadable assignment prefix cannot select a PR checkout (through the hook)', () => {
  const unreadablePrefixes = [
    ['a command substitution', () => 'GH_TOKEN=$(echo token) '],
    ['a command substitution that runs gh', () => 'GH_TOKEN=$(gh auth token) '],
    ['backticks', () => 'GH_TOKEN=`echo token` '],
    ['a nested command substitution', () => 'GH_TOKEN=$(echo $(echo token)) '],
    ['a cd before a substituted environment value', (repo) => `cd ${repo} && GH_TOKEN=$(echo token) `],
  ];
  for (const [label, buildPrefix] of unreadablePrefixes) {
    for (const [session, target] of [[FEATURE_OPTIONS, CHORE_OPTIONS], [CHORE_OPTIONS, FEATURE_OPTIONS]]) {
      const result = runAcrossCheckouts({ session, target, buildPrefix });
      assert.equal(result.json?.decision, 'block', label);
      assert.match(result.json.reason, /^PR checkout gate: cannot read the assignment prefix/, label);
    }
  }
});

test('Scenario: A gh pr create inside command substitution blocks unresolved consumer applicability (through the hook)', () => {
  // The command inside `$( ... )` is located, but its cwd cannot be resolved statically.
  // Consumer applicability must block in both directions instead of reading the session checkout.
  const buildPrefix = (repo) => `cd ${repo} && $(`;
  assertConsumerTargetBlocked(
    runAcrossCheckouts({ session: FEATURE_OPTIONS, target: CHORE_OPTIONS, buildPrefix, suffix: ' )' }),
    'command substitution, exempt target checkout',
  );
  assertConsumerTargetBlocked(
    runAcrossCheckouts({ session: CHORE_OPTIONS, target: FEATURE_OPTIONS, buildPrefix, suffix: ' )' }),
    'command substitution, feature target checkout',
  );
});

test('Scenario: An unresolved subshell cd blocks consumer applicability (through the hook)', () => {
  // The checkout the PR comes from is not resolved statically for these shapes, so consumer applicability blocks in
  // both directions instead of reading the session checkout. A prefix may need a suffix to close its construct.
  const unresolvedShapes = [
    ['a parenthesised cd', (repo) => `(cd ${repo} && `, ' )'],
    ['a parenthesised cd after another command', (repo) => `echo ok && (cd ${repo}; `, ' )'],
    ['a backtick cd', (repo) => `\`cd ${repo}\` && `, ''],
    ['a cd followed by an or-list', (repo) => `cd ${repo} && echo ok || echo no && `, ''],
  ];
  for (const [label, buildPrefix, suffix] of unresolvedShapes) {
    for (const [session, target, which] of [[FEATURE_OPTIONS, CHORE_OPTIONS, 'exempt'], [CHORE_OPTIONS, FEATURE_OPTIONS, 'feature']]) {
      const r = runAcrossCheckouts({ session, target, buildPrefix, suffix });
      assertConsumerTargetBlocked(r, `${label}, ${which} target checkout`);
      // #3560: the block names the shell forms the hook does not follow, so the writer does not suspect the path or branch.
      assert.match(r.json.reason, /PR checkout cannot be resolved before the shell runs/, `${label}, ${which}`);
      assert.match(r.json.reason, /does not follow a cd inside \( … \), \{ … \} or backticks/, `${label}, ${which}`);
    }
  }
});

test('Scenario: A gh pr create inside parentheses without a cd keeps the session checkout (through the hook)', () => {
  // A parenthesis alone moves nothing: the group runs in the session checkout, so the over-limit body blocks in a
  // feature session and passes in an exempt one. Only a cd inside the parentheses leaves the checkout unresolved.
  const buildPrefix = () => '(';
  const blocked = runAcrossCheckouts({ session: FEATURE_OPTIONS, buildPrefix, suffix: ' )' });
  assert.equal(blocked.json?.decision, 'block', 'parenthesised gh pr create, feature session');
  assert.match(blocked.json?.reason ?? '', /feature\/needs-second-review/);
  assertNotBlocked(
    runAcrossCheckouts({ session: CHORE_OPTIONS, buildPrefix, suffix: ' )' }),
    'parenthesised gh pr create, exempt session',
  );
});

// A quoted value in front of gh must not hide the command from the position match: the checkout is the one the real
// command runs in. Values are shorter and longer than the opaque placeholder "__QUOTED__" (10 characters).
const QUOTED_ENV_PREFIXES = [
  ['a short single-quoted value', () => "V='a' "],
  ['a long double-quoted value', () => 'VAR="a quoted value that is longer than the placeholder" '],
  ['two quoted assignments', () => 'A="x" B=\'a longer second value\' '],
  ['quoted text that reads like the command', () => "V='gh pr create now' "],
  ['quoted text holding a parenthesis', () => 'V="(x) and (y)" '],
];

test('Scenario: A quoted environment assignment before gh pr create keeps the checkout (through the hook, feature checkout blocks)', () => {
  for (const [label, buildPrefix] of QUOTED_ENV_PREFIXES) {
    const r = runAcrossCheckouts({ session: FEATURE_OPTIONS, buildPrefix });
    assert.equal(r.json?.decision, 'block', `${label} in the session feature checkout must block\njson: ${JSON.stringify(r.json)}`);
    assert.ok((r.json.reason || '').includes('branch=feature/needs-second-review'), `${label}\n${r.json.reason}`);
    // After a cd the checkout is the cd target: the exempt session checkout does not hide the feature target.
    const moved = runAcrossCheckouts({
      session: CHORE_OPTIONS,
      target: FEATURE_OPTIONS,
      buildPrefix: (repo) => `cd ${repo} && ${buildPrefix()}`,
    });
    assert.equal(moved.json?.decision, 'block', `${label} after a cd into the feature checkout must block\njson: ${JSON.stringify(moved.json)}`);
  }
});

test('Scenario: A quoted environment assignment before gh pr create keeps the checkout (through the hook, exempt checkout not blocked)', () => {
  for (const [label, buildPrefix] of QUOTED_ENV_PREFIXES) {
    assertNotBlocked(runAcrossCheckouts({ session: CHORE_OPTIONS, buildPrefix }), `${label} in the exempt session checkout`);
    assertNotBlocked(
      runAcrossCheckouts({
        session: FEATURE_OPTIONS,
        target: CHORE_OPTIONS,
        buildPrefix: (repo) => `cd ${repo} && ${buildPrefix()}`,
      }),
      `${label} after a cd into the exempt checkout`,
    );
  }
});

// A redirect or a pipeline that holds no chdir between the cd and gh pr create does not hide the checkout either.
const REDIRECT_PIPE_BETWEEN = [
  ['a stderr redirect', ' echo ok 2>&1 &&'],
  ['a descriptor duplication', ' echo ok >&2 &&'],
  ['a combined redirect', ' echo ok &>/dev/null &&'],
  ['a pipeline', ' echo ok | cat &&'],
  ['a pipe with stderr', ' echo ok |& cat &&'],
];

test('Scenario: A redirect or a pipeline between cd and gh pr create keeps the checkout (through the hook)', () => {
  for (const [label, between] of REDIRECT_PIPE_BETWEEN) {
    const buildPrefix = (repo) => `cd ${repo} &&${between} `;
    const toFeature = runAcrossCheckouts({ session: CHORE_OPTIONS, target: FEATURE_OPTIONS, buildPrefix });
    assert.equal(toFeature.json?.decision, 'block', `${label}: the cd target is the feature checkout, so it must block\njson: ${JSON.stringify(toFeature.json)}`);
    assertNotBlocked(
      runAcrossCheckouts({ session: FEATURE_OPTIONS, target: CHORE_OPTIONS, buildPrefix }),
      `${label}: the cd target is the exempt checkout`,
    );
  }
  // A chdir that is itself an element of a pipeline is not a cd that took effect: unresolved, so consumer applicability blocks.
  const pipedChdir = [
    (repo) => `echo ok | cd ${repo} && `,
    (repo) => `cd ${repo} | cat && `,
    (repo) => `cd ${repo} |& cat && `,
  ];
  for (const buildPrefix of pipedChdir) {
    assertConsumerTargetBlocked(
      runAcrossCheckouts({ session: FEATURE_OPTIONS, target: CHORE_OPTIONS, buildPrefix }),
      `piped chdir [${buildPrefix('X')}], exempt target`,
    );
    assertConsumerTargetBlocked(
      runAcrossCheckouts({ session: CHORE_OPTIONS, target: FEATURE_OPTIONS, buildPrefix }),
      `piped chdir [${buildPrefix('X')}], feature target`,
    );
  }
});

test('Scenario: A cd to another checkout moves the cost-override disclosure check (through the hook)', () => {
  // Cost-override disclosure reads the checkpoint of the checkout the PR comes from and its branch, like the evidence
  // checks: the session checkpoint never decides a PR made from another checkout.
  withChangeUsageStateDir(() => {
    const sessionChange = 'pr-cwd-disclosure-session';
    const targetChange = 'pr-cwd-disclosure-target';
    const targetOid = 'c'.repeat(40);
    const sessionRepo = makeEvidenceRepo({ branch: `bugfix/${sessionChange}` });
    const noCheckpointRepo = makeEvidenceRepo({ branch: 'chore/tidy-notes' });
    const targetRepo = makeEvidenceRepo({ branch: `bugfix/${targetChange}` });
    const bodyDir = makeTempDir('pr-body-gate-disclosure-body-');
    try {
      for (const [cwd, changeName, oid] of [[sessionRepo, sessionChange, 'b'.repeat(40)], [targetRepo, targetChange, targetOid]]) {
        mkdirSync(path.join(cwd, 'openspec', 'changes', changeName), { recursive: true });
        appendChangeUsageOverride({ cwd, changeName, session_id: 's1', at: '2026-01-01T00:00:00.000Z', thresholds: ['output'], head_ref_oid: oid });
      }
      // VALID_PR_BODY discloses N/A, which none of the recorded overrides accept.
      const bodyFile = path.join(bodyDir, 'pr-body.md');
      writeFileSync(bodyFile, VALID_PR_BODY, 'utf8');
      const run = (prefix) => runHook({
        tool_name: 'Bash',
        tool_input: { command: `${prefix}gh pr create --title "fix: x" --body-file ${bodyFile}`, cwd: sessionRepo },
      });
      // Control: in the session checkout its own checkpoint blocks.
      const control = run('');
      assert.equal(control.json?.decision, 'block', `control must block\njson: ${JSON.stringify(control.json)} stderr=${control.stderr}`);
      assert.match(control.json.reason, /Cost Circuit Breaker|override/i);
      // A checkout whose change has no checkpoint: the session checkpoint does not follow the cd.
      assertNotBlocked(run(cdTo(noCheckpointRepo)), 'cd into a checkout without a checkpoint');
      // A checkout with its own override: its checkpoint blocks and names its line.
      const blocked = run(cdTo(targetRepo));
      assert.equal(blocked.json?.decision, 'block', `json: ${JSON.stringify(blocked.json)} stderr=${blocked.stderr}`);
      assert.ok(blocked.json.reason.includes(`head_ref_oid=${targetOid}`), `the expected line comes from the PR checkout\n${blocked.json.reason}`);
    } finally {
      for (const dir of [sessionRepo, noCheckpointRepo, targetRepo, bodyDir]) rmSync(dir, { recursive: true, force: true });
    }
  });
});

// notes/session-pending.md of the fixture checkout, which is its own main checkout.
// null writes nothing; 'unreadable' puts a directory where the file should be.
function writeWaiverNotes(repo, notes) {
  if (notes === null || notes === undefined) return;
  mkdirSync(path.join(repo, 'notes'), { recursive: true });
  if (notes === 'unreadable') mkdirSync(path.join(repo, 'notes/session-pending.md'));
  else writeFileSync(path.join(repo, 'notes/session-pending.md'), notes);
}

// #3398: use real Git checkouts; text evidence is not proof that checks ran.
function makeConsumerChecksRepo({ tracked = true, source = false, adopted = false } = {}) {
  const repo = makeEvidenceRepo();
  mkdirSync(path.join(repo, '.devpro'), { recursive: true });
  writeFileSync(path.join(repo, '.devpro/pre-pr-checks.local.md'), 'Run project checks.\n');
  if (source) {
    mkdirSync(path.join(repo, '.devpro/agent-rules'), { recursive: true });
    mkdirSync(path.join(repo, '.devpro/scripts'), { recursive: true });
    writeFileSync(path.join(repo, '.devpro/agent-rules/rule-audit-playbook.md'), 'source');
    writeFileSync(path.join(repo, '.devpro/scripts/pre-pr-archive-gate.mjs'), 'source');
    evidenceGit(repo, ['remote', 'add', 'origin', 'https://example.invalid/devpro-agent-rules.git']);
  }
  if (adopted) {
    const installed = path.join(repo, '.devpro-agent-rules');
    mkdirSync(path.join(installed, '.devpro/scripts'), { recursive: true });
    writeFileSync(path.join(installed, 'AGENTS.md'), 'consumer rules');
    writeFileSync(path.join(installed, '.devpro/scripts/sync-agent-rules.mjs'), 'consumer rules');
    evidenceGit(repo, ['remote', 'add', 'origin', 'https://github.com/example/consumer.git']);
  }
  if (tracked) {
    evidenceGit(repo, ['add', '.devpro']);
    evidenceGit(repo, ['commit', '-q', '--no-verify', '-m', 'checks']);
  }
  return repo;
}

function runConsumerBody(repo, body, { level = 'lite', flags = '', prefix = '', bodyFile = false, inlineFlag = '--body' } = {}) {
  const file = path.join(repo, 'pr-body.md');
  writeFileSync(file, body);
  const bodyFlag = bodyFile ? `--body-file ${file}` : `${inlineFlag} '${body.replaceAll("'", "'\\''")}'`;
  return runHook({ tool_name: 'Bash', tool_input: { cwd: repo, command: `${prefix}gh pr create --title "fix: checks" ${flags} ${bodyFlag}` } }, { DEVPRO_AGENT_RULES_LEVEL: level });
}

test('#3398 consumer checks: lite/full reject missing, empty, placeholder and fenced evidence', () => {
  const repo = makeConsumerChecksRepo();
  try {
    const sha = evidenceGit(repo, ['rev-parse', 'HEAD']);
    for (const level of ['lite', 'full']) {
      for (const line of ['', `Consumer pre-PR checks: HEAD ${sha};`, `Consumer pre-PR checks: HEAD ${sha}; TODO`, `\`\`\`\nConsumer pre-PR checks: HEAD ${sha}; passed\n\`\`\``]) {
        const body = VALID_PR_BODY.replace('## Test Evidence\n', `## Test Evidence\n${line}\n`);
        const r = runConsumerBody(repo, body, { level });
        assert.equal(r.json?.decision, 'block', `${level}: ${line}\n${r.stdout}`);
        assert.match(r.json.reason, /Consumer pre-PR checks/);
      }
    }
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('#3398 consumer checks: valid inline/bodyfile and user waiver pass; off is exempt', () => {
  const repo = makeConsumerChecksRepo();
  try {
    const sha = evidenceGit(repo, ['rev-parse', 'HEAD']);
    for (const bodyFile of [false, true]) {
      for (const result of ['project checks passed']) {
        const body = VALID_PR_BODY.replace('## Test Evidence\n', `## Test Evidence\n- Consumer pre-PR checks: HEAD ${sha}; ${result}\n`);
        assertNotBlocked(runConsumerBody(repo, body, { bodyFile }), `${bodyFile}: ${result}`);
      }
    }
    const short = runConsumerBody(repo, VALID_PR_BODY, { inlineFlag: '-b' });
    assert.equal(short.json?.decision, 'block', short.stdout);
    assertNotBlocked(runConsumerBody(repo, VALID_PR_BODY, { level: 'off' }), 'off');
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// [Scenario: openspec-flow :: Each Consumer release needs its own record]
test('#3398 consumer checks: a user waiver with a matching consumer_waiver record passes', () => {
  const repo = makeConsumerChecksRepo();
  try {
    const sha = evidenceGit(repo, ['rev-parse', 'HEAD']);
    writeWaiverNotes(repo, waiverCases.notesOf(waiverCases.entry({ claims: ['evidence-hook-case'], prBranch: [EVIDENCE_BRANCH], records: [waiverCases.consumerRecord('unavailable browser')] })));
    for (const bodyFile of [false, true]) {
      const body = VALID_PR_BODY.replace('## Test Evidence\n', `## Test Evidence\n- Consumer pre-PR checks: HEAD ${sha}; skipped per user decision: unavailable browser\n`);
      assertNotBlocked(runConsumerBody(repo, body, { bodyFile }), `bodyFile=${bodyFile}`);
    }
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// [Scenario: openspec-flow :: A waiver without a matching answer-time record blocks PR creation]
test('#3398 consumer checks: a user waiver without a record blocks at the Consumer pre-PR checks gate', () => {
  const repo = makeConsumerChecksRepo();
  try {
    const sha = evidenceGit(repo, ['rev-parse', 'HEAD']);
    for (const bodyFile of [false, true]) {
      const body = VALID_PR_BODY.replace('## Test Evidence\n', `## Test Evidence\n- Consumer pre-PR checks: HEAD ${sha}; skipped per user decision: unavailable browser\n`);
      const r = runConsumerBody(repo, body, { bodyFile });
      assert.equal(r.json?.decision, 'block', `bodyFile=${bodyFile}\n${r.stdout}`);
      assert.match(r.json.reason, /^Consumer pre-PR checks gate: /);
      assert.match(r.json.reason, /notes\/session-pending\.md/);
      assert.match(r.json.reason, /ask the user/);
    }
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('#3398 consumer checks: working-tree-only blocks; source ignores same-name file', () => {
  for (const source of [false, true]) {
    const repo = makeConsumerChecksRepo({ tracked: false, source });
    try {
      const r = runConsumerBody(repo, VALID_PR_BODY);
      if (source) assertNotBlocked(r, 'source');
      else {
        assert.equal(r.json?.decision, 'block', r.stdout);
        assert.match(r.json.reason, /commit/);
      }
    } finally { rmSync(repo, { recursive: true, force: true }); }
  }
});

test('#3398 evidence format: only one live Test Evidence line with full SHA and filled result counts', () => {
  const sha = 'a'.repeat(40);
  const line = `Consumer pre-PR checks: HEAD ${sha}; checks passed`;
  assert.equal(consumerPrePrEvidenceError(`## Test Evidence\n- ${line}\n`), null);
  for (const body of [
    `## Other\n${line}`,
    `## Test Evidence\n~~~\n${line}\n~~~`,
    `\`\`\`\n## Test Evidence\n${line}\n\`\`\``,
    `## Test Evidence\n<!-- ${line} -->`,
    `## Test Evidence\n${line}\n${line}`,
    `## Test Evidence\n${line.replace(sha, 'abcdef0')}`,
    ...['', 'TODO', 'TBD', '[fill result]', '<result>', 'placeholder', '`<result>`', 'N/A', 'skipped per user decision:'].map((result) => `## Test Evidence\nConsumer pre-PR checks: HEAD ${sha}; ${result}`),
  ]) assert.ok(consumerPrePrEvidenceError(body), body);
});

test('#3398 absent file keeps inline and unreadable template lint semantics; Git HEAD failure blocks', () => {
  // Generic fail-open now belongs to a positive source checkout; unknown without the line is blocked.
  // [Scenario: pre-tool-mechanical-gates :: gh pr create with inline body fails open]
  // [Scenario: pre-tool-mechanical-gates :: gh pr create with unreadable body file does not block]
  const repo = makeSourceBodyRepo('consumer-checks-absent-');
  const unknown = makeBodyRepo('consumer-checks-absent-unknown-');
  const invalid = makeTempDir('consumer-checks-invalid-head-');
  try {
    assertNotBlocked(runConsumerBody(repo, 'inline generic body'), 'no checks file');
    const r = runHook({ tool_name: 'Bash', tool_input: { cwd: repo, command: 'gh pr create --body-file /nonexistent-consumer-body.md' } });
    assertNotBlocked(r, 'no checks unreadable file');
    assertDevBlocked(runConsumerBody(unknown, 'inline generic body'), 'unknown: inline body without the DEV line', 'unknown');
    assertDevBlocked(runHook({ tool_name: 'Bash', tool_input: { cwd: unknown, command: 'gh pr create --body-file /nonexistent-consumer-body.md' } }), 'unknown: unreadable body file', 'unknown');
    evidenceGit(invalid, ['init', '-q', '-b', 'bugfix/check-head']);
    const bad = runConsumerBody(invalid, VALID_PR_BODY);
    assert.equal(bad.json?.decision, 'block', bad.stdout);
    assert.match(bad.json.reason, /Git HEAD checks query failed/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(unknown, { recursive: true, force: true });
    rmSync(invalid, { recursive: true, force: true });
  }
});

test('#3398 applicable unreadable body and unresolvable checkout/head block with body-file recipe', () => {
  const repo = makeConsumerChecksRepo();
  try {
    for (const command of [
      'gh pr create --body-file /nonexistent-consumer-body.md',
      'gh pr create -F -',
      'gh pr create --fill',
      'cd "$TARGET" && gh pr create --body "body"',
      'gh pr create --head "$HEAD_BRANCH" --body "body"',
      'gh pr create --head no-such-branch --body "body"',
      'gh pr create --head fork-owner:bugfix/check-body --body "body"',
    ]) {
      const r = runHook({ tool_name: 'Bash', tool_input: { cwd: repo, command } }, { DEVPRO_AGENT_RULES_LEVEL: 'lite' });
      assert.equal(r.json?.decision, 'block', `${command}\n${r.stdout}`);
      assert.match(r.json.reason, /Consumer pre-PR checks gate/);
      assert.match(r.json.reason, /--body-file <absolute-body-file>/);
    }
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('#3398 cd chooses actual checkout and relative body file; no-file checkout remains exempt', () => {
  const session = makeBodyRepo('consumer-checks-session-');
  const target = makeConsumerChecksRepo();
  try {
    const sha = evidenceGit(target, ['rev-parse', 'HEAD']);
    writeFileSync(path.join(target, 'relative-body.md'), VALID_PR_BODY.replace('## Test Evidence\n', `## Test Evidence\nConsumer pre-PR checks: HEAD ${sha}; project checks passed\n`));
    const run = (cwd, command) => runHook({ tool_name: 'Bash', tool_input: { cwd, command } });
    assert.equal(run(session, `cd ${target} && gh pr create --body 'no evidence'`).json?.decision, 'block');
    assertNotBlocked(run(session, `cd ${target} && gh pr create -F relative-body.md`), 'relative to actual PR checkout');
    // A no-file checkout is no longer exempt: unknown identity follows the consumer rules for the DEV line.
    assertDevBlocked(run(target, `cd ${session} && gh pr create -b 'no consumer file'`), 'cd to no-file checkout, no DEV line', 'unknown');
    const devBody = path.join(target, 'dev-body.md');
    writeFileSync(devBody, VALID_PR_BODY);
    assertNotBlocked(run(target, `cd ${session} && gh pr create -F ${devBody}`), 'cd to no-file checkout, DEV line present');
  } finally {
    rmSync(session, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test('#3398 quoted foreign --head follows matching local worktree and allows ancestor text evidence', () => {
  const session = makeBodyRepo('consumer-checks-head-session-');
  const target = makeTempDir('consumer-checks-head-target-');
  const head = 'bugfix/check-consumer-head';
  try {
    evidenceGit(session, ['worktree', 'add', '-q', '-b', head, target]);
    mkdirSync(path.join(target, '.devpro'), { recursive: true });
    writeFileSync(path.join(target, '.devpro/pre-pr-checks.local.md'), 'Run checks.\n');
    evidenceGit(target, ['add', '.devpro']);
    evidenceGit(target, ['commit', '-q', '--no-verify', '-m', 'checks']);
    const sha = evidenceGit(target, ['rev-parse', 'HEAD']);
    assert.equal(runConsumerBody(session, VALID_PR_BODY, { flags: `--head '${head}'` }).json?.decision, 'block');
    mkdirSync(path.join(target, 'docs'), { recursive: true });
    writeFileSync(path.join(target, 'docs/accounting.md'), 'record\n');
    evidenceGit(target, ['add', 'docs']);
    evidenceGit(target, ['commit', '-q', '--no-verify', '-m', 'accounting']);
    const body = VALID_PR_BODY.replace('## Test Evidence\n', `## Test Evidence\nConsumer pre-PR checks: HEAD ${sha}; checks passed\n`);
    assertNotBlocked(runConsumerBody(session, body, { flags: `--head '${head}'` }), 'matching target and ancestor evidence');
  } finally {
    rmSync(session, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test('#3398 source exemption cannot authorize a foreign --repo/-R and each create clause is checked', () => {
  const source = makeConsumerChecksRepo({ source: true });
  const consumer = makeConsumerChecksRepo();
  try {
    evidenceGit(source, ['remote', 'set-url', 'origin', 'https://github.com/example/devpro-agent-rules.git']);
    assertNotBlocked(runConsumerBody(source, 'source inline', { flags: '--repo example/devpro-agent-rules' }), 'same source repo');
    for (const flags of ['--repo other/consumer', '-R other/consumer', '--repo "$TARGET_REPO"']) {
      const r = runConsumerBody(source, VALID_PR_BODY, { flags });
      assert.equal(r.json?.decision, 'block', r.stdout);
      // add-cross-repo-pr-scope-marker: a foreign or shell-expanded --repo is now blocked by the earlier Cross-repo PR
      // write gate; the source exemption still does not authorize it.
      assert.match(r.json.reason, /^Cross-repo PR write gate/, flags);
    }
    const command = `gh pr create --body 'exempt source' && cd ${consumer} && gh pr create --body 'missing evidence'`;
    const r = runHook({ tool_name: 'Bash', tool_input: { cwd: source, command } });
    assert.equal(r.json?.decision, 'block', r.stdout);
    assert.match(r.json.reason, /Consumer pre-PR checks/);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(consumer, { recursive: true, force: true });
  }
});


test('#3398 positive consumer identity and staged/ignored working-only checks still block', () => {
  const adopted = makeConsumerChecksRepo({ adopted: true });
  try {
    assertConsumerTargetBlocked(runConsumerBody(adopted, VALID_PR_BODY), 'positive consumer identity');
  } finally { rmSync(adopted, { recursive: true, force: true }); }
  for (const state of ['staged', 'ignored']) {
    const repo = makeConsumerChecksRepo({ tracked: false });
    try {
      if (state === 'staged') evidenceGit(repo, ['add', '.devpro/pre-pr-checks.local.md']);
      else writeFileSync(path.join(repo, '.gitignore'), '.devpro/pre-pr-checks.local.md\n');
      const r = runConsumerBody(repo, VALID_PR_BODY);
      assertConsumerTargetBlocked(r, state);
      assert.match(r.json.reason, /commit/);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  }
});

test('#3398 working-tree Git query failure blocks rather than treating the file as absent', () => {
  const repo = makeBodyRepo('consumer-checks-bad-index-');
  try {
    writeFileSync(path.join(repo, '.git/index'), 'invalid index');
    const r = runConsumerBody(repo, VALID_PR_BODY);
    assertConsumerTargetBlocked(r, 'corrupt Git index');
    assert.match(r.json.reason, /Git working-tree checks query failed/);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// DEV deploy-verify line: consumer and unknown identities need it whether or not
// the local checks file exists; positive source and rigor off are exempt.
// Text format only; whether DEV was really deployed stays cooperative.
const BODY_WITHOUT_DEV = () => VALID_PR_BODY.replace(`${DEV_FIXTURE_LINE}\n`, '');
const withEvidence = (...lines) => BODY_WITHOUT_DEV().replace('## Test Evidence\n', `## Test Evidence\n${lines.join('\n')}\n`);

// A consumer identity without the checks file: adoption evidence plus an origin.
function makeNoFileConsumerRepo() {
  const repo = makeBodyRepo('consumer-no-file-');
  const installed = path.join(repo, '.devpro-agent-rules');
  mkdirSync(path.join(installed, '.devpro/scripts'), { recursive: true });
  writeFileSync(path.join(installed, 'AGENTS.md'), 'consumer rules');
  writeFileSync(path.join(installed, '.devpro/scripts/sync-agent-rules.mjs'), 'consumer rules');
  evidenceGit(repo, ['remote', 'add', 'origin', 'https://github.com/example/consumer.git']);
  return repo;
}

function assertDevBlocked(r, label, identity) {
  assert.equal(r.json?.decision, 'block', `${label}\n${r.stdout}`);
  assert.match(r.json.reason, /^DEV deploy-verify gate: /, label);
  assert.match(r.json.reason, new RegExp(`Repository identity: ${identity} \\(`), label);
  assert.match(r.json.reason, /only a positive source identity is exempt/, label);
  assert.match(r.json.reason, /--body-file <absolute-body-file>/, label);
  assert.match(r.json.reason, /pre-pr-dev-verification\.md/, label);
}

// [Scenario: openspec-flow :: PR create gate requires a DEV deploy-verify line for consumer PRs]
test('DEV deploy-verify gate: consumer and unknown without a checks file block a missing, duplicate, empty or placeholder line', () => {
  const sha = 'c'.repeat(40);
  for (const [identity, make] of [['unknown', () => makeBodyRepo('dev-gate-unknown-')], ['consumer', makeNoFileConsumerRepo]]) {
    const repo = make();
    try {
      for (const level of ['lite', 'full']) {
        for (const [name, body] of [
          ['missing line', BODY_WITHOUT_DEV()],
          ['two lines', withEvidence(`DEV deploy-verify: HEAD ${sha}; N/A: a`, `DEV deploy-verify: HEAD ${sha}; N/A: b`)],
          ['empty N/A shell', withEvidence(`DEV deploy-verify: HEAD ${sha}; N/A:`)],
          ['empty pending shell', withEvidence(`DEV deploy-verify: HEAD ${sha}; pending:`)],
          ['placeholder', withEvidence(`DEV deploy-verify: HEAD ${sha}; <result summary>`)],
          ['short sha', withEvidence('DEV deploy-verify: HEAD abcdef0; N/A: docs only')],
          ['fenced line', withEvidence(`\`\`\`\nDEV deploy-verify: HEAD ${sha}; N/A: docs only\n\`\`\``)],
        ]) {
          for (const bodyFile of [false, true]) {
            assertDevBlocked(runConsumerBody(repo, body, { level, bodyFile }), `${identity} ${level} ${name} bodyFile=${bodyFile}`, identity);
          }
        }
      }
    } finally { rmSync(repo, { recursive: true, force: true }); }
  }
});

test('DEV deploy-verify gate: not verified is rejected and points to pending', () => {
  const repo = makeBodyRepo('dev-gate-not-verified-');
  try {
    const r = runConsumerBody(repo, withEvidence(`DEV deploy-verify: HEAD ${'c'.repeat(40)}; not verified`), { bodyFile: true });
    assertDevBlocked(r, 'not verified', 'unknown');
    assert.match(r.json.reason, /write pending: <what is missing> instead/);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// [Scenario: openspec-flow :: A documentation-only change records N/A with a reason]
test('DEV deploy-verify gate: N/A with a reason, pending and a result summary pass without a checks file', () => {
  const sha = 'c'.repeat(40);
  for (const make of [() => makeBodyRepo('dev-gate-pass-unknown-'), makeNoFileConsumerRepo]) {
    const repo = make();
    try {
      for (const status of ['N/A: docs only', 'pending: x', 'deployed PR head build to DEV, login path passed']) {
        for (const bodyFile of [false, true]) {
          assertNotBlocked(runConsumerBody(repo, withEvidence(`- DEV deploy-verify: HEAD ${sha}; ${status}`), { bodyFile }), `${status} bodyFile=${bodyFile}`);
        }
      }
    } finally { rmSync(repo, { recursive: true, force: true }); }
  }
});

// [Scenario: openspec-flow :: A matching answer-time record lets the waiver pass]
test('DEV deploy-verify gate: skipped per user decision passes with a matching waived record, without a checks file', () => {
  const sha = 'c'.repeat(40);
  for (const make of [() => makeBodyRepo('dev-gate-waiver-unknown-'), makeNoFileConsumerRepo]) {
    const repo = make();
    try {
      writeWaiverNotes(repo, waiverCases.notesOf(waiverCases.entry({ claims: ['check-body'], prBranch: ['chore/check-body'], records: [waiverCases.devRecord('y')] })));
      for (const bodyFile of [false, true]) {
        assertNotBlocked(runConsumerBody(repo, withEvidence(`- DEV deploy-verify: HEAD ${sha}; skipped per user decision: y`), { bodyFile }), `bodyFile=${bodyFile}`);
      }
    } finally { rmSync(repo, { recursive: true, force: true }); }
  }
});

// [Scenario: openspec-flow :: A waiver without a matching answer-time record blocks PR creation]
test('DEV deploy-verify gate: skipped per user decision without a record blocks at the DEV deploy-verify gate', () => {
  const sha = 'c'.repeat(40);
  for (const make of [() => makeBodyRepo('dev-gate-no-record-unknown-'), makeNoFileConsumerRepo]) {
    const repo = make();
    try {
      for (const bodyFile of [false, true]) {
        const r = runConsumerBody(repo, withEvidence(`- DEV deploy-verify: HEAD ${sha}; skipped per user decision: y`), { bodyFile });
        assert.equal(r.json?.decision, 'block', `bodyFile=${bodyFile}\n${r.stdout}`);
        assert.match(r.json.reason, /^DEV deploy-verify gate: /);
        assert.match(r.json.reason, /check-body/);
        assert.match(r.json.reason, /chore\/check-body/);
        assert.match(r.json.reason, /notes\/session-pending\.md/);
        assert.match(r.json.reason, /ask the user/);
      }
    } finally { rmSync(repo, { recursive: true, force: true }); }
  }
});

test('DEV deploy-verify gate: an inline body that cannot be extracted or a create without a body flag blocks for unknown and consumer', () => {
  for (const [identity, make] of [['unknown', () => makeBodyRepo('dev-gate-unreadable-unknown-')], ['consumer', makeNoFileConsumerRepo]]) {
    const repo = make();
    try {
      for (const command of [
        'gh pr create --body-file /nonexistent-consumer-body.md',
        'gh pr create -F -',
        'gh pr create --fill',
        'gh pr create --body "$BODY_TEXT"',
      ]) {
        const r = runHook({ tool_name: 'Bash', tool_input: { cwd: repo, command } }, { DEVPRO_AGENT_RULES_LEVEL: 'lite' });
        assertDevBlocked(r, command, identity);
      }
    } finally { rmSync(repo, { recursive: true, force: true }); }
  }
});

// [Scenario: openspec-flow :: Source repository and rigor off are out of scope]
test('DEV deploy-verify gate: a positive source repository and rigor off are not asked for the line', () => {
  const source = makeConsumerChecksRepo({ source: true });
  try {
    for (const level of ['lite', 'full']) assertNotBlocked(runConsumerBody(source, BODY_WITHOUT_DEV(), { level }), `source ${level}`);
    assertNotBlocked(runHook({ tool_name: 'Bash', tool_input: { cwd: source, command: 'gh pr create --fill' } }, { DEVPRO_AGENT_RULES_LEVEL: 'lite' }), 'source fail-open');
  } finally { rmSync(source, { recursive: true, force: true }); }
  for (const make of [() => makeBodyRepo('dev-gate-off-unknown-'), makeNoFileConsumerRepo]) {
    const repo = make();
    try {
      assertNotBlocked(runConsumerBody(repo, BODY_WITHOUT_DEV(), { level: 'off' }), 'off');
      assert.equal(runConsumerBody(repo, BODY_WITHOUT_DEV(), { level: 'full' }).json?.decision, 'block');
    } finally { rmSync(repo, { recursive: true, force: true }); }
  }
});

test('DEV deploy-verify gate: with a tracked checks file the Consumer pre-PR checks line is still required, and the DEV line too', () => {
  const repo = makeConsumerChecksRepo();
  try {
    const sha = evidenceGit(repo, ['rev-parse', 'HEAD']);
    const checks = `Consumer pre-PR checks: HEAD ${sha}; project checks passed`;
    const dev = `DEV deploy-verify: HEAD ${sha}; N/A: docs only`;
    const onlyChecks = runConsumerBody(repo, withEvidence(checks));
    assertDevBlocked(onlyChecks, 'checks line only', 'unknown');
    const onlyDev = runConsumerBody(repo, withEvidence(dev));
    assert.equal(onlyDev.json?.decision, 'block', onlyDev.stdout);
    assert.match(onlyDev.json.reason, /Consumer pre-PR checks gate/);
    assertNotBlocked(runConsumerBody(repo, withEvidence(checks, dev)), 'both lines');
    assertNotBlocked(runConsumerBody(repo, withEvidence(checks, dev), { bodyFile: true }), 'both lines, body file');
    assertNotBlocked(runConsumerBody(repo, BODY_WITHOUT_DEV(), { level: 'off' }), 'off');
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// [Scenario: openspec-flow :: Source repository and rigor off are out of scope]
// A --head that names another local worktree re-reads the identity there; a
// positive source target stays exempt instead of falling into the DEV line check.
test('DEV deploy-verify gate: --head naming a positive source worktree stays exempt', () => {
  const session = makeBodyRepo('dev-gate-head-session-');
  const target = makeTempDir('dev-gate-head-source-target-');
  const head = 'chore/source-target';
  try {
    evidenceGit(session, ['remote', 'add', 'origin', 'https://example.invalid/devpro-agent-rules.git']);
    evidenceGit(session, ['worktree', 'add', '-q', '-b', head, target]);
    mkdirSync(path.join(target, '.devpro/agent-rules'), { recursive: true });
    mkdirSync(path.join(target, '.devpro/scripts'), { recursive: true });
    writeFileSync(path.join(target, '.devpro/agent-rules/rule-audit-playbook.md'), 'source');
    writeFileSync(path.join(target, '.devpro/scripts/pre-pr-archive-gate.mjs'), 'source');
    evidenceGit(target, ['add', '.devpro']);
    evidenceGit(target, ['commit', '-q', '--no-verify', '-m', 'source sentinels']);
    assertDevBlocked(runConsumerBody(session, BODY_WITHOUT_DEV()), 'session checkout itself', 'unknown');
    const r = runConsumerBody(session, BODY_WITHOUT_DEV(), { flags: `--head ${head}` });
    assert.doesNotMatch(r.stdout, /Repository identity: undefined/, 'no undefined identity in a block reason');
    assertNotBlocked(r, 'positive source --head target');
  } finally {
    rmSync(session, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

// ── Per-PR waiver comparison: the shared case table through Gate 4c ──────────

function makeWaiverRepo({ branch, checksFile }) {
  const repo = makeTempDir('waiver-gate-');
  evidenceGit(repo, ['init', '-q', '-b', branch]);
  if (checksFile) {
    mkdirSync(path.join(repo, '.devpro'), { recursive: true });
    writeFileSync(path.join(repo, '.devpro/pre-pr-checks.local.md'), 'Run project checks.\n');
    evidenceGit(repo, ['add', '.devpro']);
  }
  evidenceGit(repo, ['commit', '--allow-empty', '-q', '--no-verify', '-m', 'init']);
  return repo;
}

function waiverBody(sha, c) {
  const lines = [`DEV deploy-verify: HEAD ${sha}; ${c.dev}`];
  if (c.consumer) lines.push(`Consumer pre-PR checks: HEAD ${sha}; ${c.consumer}`);
  return withEvidence(...lines);
}

// [Scenario: openspec-flow :: A waiver without a matching answer-time record blocks PR creation]
// [Scenario: openspec-flow :: A matching answer-time record lets the waiver pass]
// [Scenario: openspec-flow :: A record of another reason, kind, or change does not match]
// [Scenario: openspec-flow :: Records that cannot be located, read, or told apart block only waiver lines]
// [Scenario: openspec-flow :: Each Consumer release needs its own record]
// [Scenario: openspec-flow :: A record entry that also claims another change or is bound to another branch does not match]
for (const c of waiverCases.CASES) {
  test(`[Scenario: openspec-flow :: ${c.scenario}] ${c.id} (Gate 4c)`, () => {
    const repo = makeWaiverRepo({ branch: c.branch ?? waiverCases.BRANCH, checksFile: Boolean(c.checksFile) });
    try {
      writeWaiverNotes(repo, c.notes);
      const sha = evidenceGit(repo, ['rev-parse', 'HEAD']);
      for (const bodyFile of [false, true]) {
        const r = runConsumerBody(repo, waiverBody(sha, c), { bodyFile });
        if (!c.expect.block) {
          assertNotBlocked(r, `${c.id} bodyFile=${bodyFile}`);
          continue;
        }
        assert.equal(r.json?.decision, 'block', `${c.id} bodyFile=${bodyFile}\n${r.stdout}`);
        assert.ok(r.json.reason.startsWith(`${c.expect.gate}: `), `${c.id}: ${r.json.reason}`);
        for (const needle of c.expect.includes) assert.ok(r.json.reason.includes(needle), `${c.id}: missing ${needle}\n${r.json.reason}`);
        for (const needle of c.expect.excludes) assert.ok(!r.json.reason.includes(needle), `${c.id}: must not contain ${needle}\n${r.json.reason}`);
      }
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
}

// [Scenario: openspec-flow :: A record entry that also claims another change or is bound to another branch does not match]
test('waiver comparison: --head naming another worktree locates the record by that worktree branch, in the main checkout notes', () => {
  const session = makeBodyRepo('waiver-head-session-');
  const target = makeTempDir('waiver-head-target-');
  const head = 'bugfix/waiver-head';
  try {
    evidenceGit(session, ['worktree', 'add', '-q', '-b', head, target]);
    const sha = evidenceGit(target, ['rev-parse', 'HEAD']);
    const body = withEvidence(`DEV deploy-verify: HEAD ${sha}; skipped per user decision: y`);
    // The session branch (chore/check-body) has a matching record; the --head target does not.
    writeWaiverNotes(session, waiverCases.notesOf(waiverCases.entry({ claims: ['check-body'], prBranch: ['chore/check-body'], records: [waiverCases.devRecord('y')] })));
    const blocked = runConsumerBody(session, body, { flags: `--head '${head}'` });
    assert.equal(blocked.json?.decision, 'block', blocked.stdout);
    assert.match(blocked.json.reason, /^DEV deploy-verify gate: /);
    assert.match(blocked.json.reason, /waiver-head \(branch bugfix\/waiver-head\)/);
    // Records of the target branch live in the main checkout notes, not in the target worktree.
    writeWaiverNotes(session, waiverCases.notesOf(waiverCases.entry({ claims: ['waiver-head'], prBranch: [head], records: [waiverCases.devRecord('y')] })));
    mkdirSync(path.join(target, 'notes'), { recursive: true });
    writeFileSync(path.join(target, 'notes/session-pending.md'), waiverCases.notesOf(waiverCases.entry({ claims: ['waiver-head'], prBranch: ['feature/other'], records: [] })));
    assertNotBlocked(runConsumerBody(session, body, { flags: `--head '${head}'` }), '--head target branch matches its record');
  } finally {
    rmSync(session, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

// [Scenario: openspec-flow :: Source repository and rigor off do not compare waiver records]
test('waiver comparison: a positive source repository and rigor off do not compare waiver lines, with no record', () => {
  const sha = 'c'.repeat(40);
  const waived = withEvidence(`DEV deploy-verify: HEAD ${sha}; skipped per user decision: y`);
  const both = withEvidence(`Consumer pre-PR checks: HEAD ${sha}; skipped per user decision: z`, `DEV deploy-verify: HEAD ${sha}; skipped per user decision: y`);
  const source = makeConsumerChecksRepo({ source: true });
  try {
    for (const level of ['lite', 'full']) {
      assertNotBlocked(runConsumerBody(source, waived, { level }), `source ${level}`);
      assertNotBlocked(runConsumerBody(source, both, { level }), `source ${level} both lines`);
    }
  } finally { rmSync(source, { recursive: true, force: true }); }
  const tracked = makeConsumerChecksRepo();
  try {
    assertNotBlocked(runConsumerBody(tracked, both, { level: 'off' }), 'tracked checks file, off');
    assert.equal(runConsumerBody(tracked, both, { level: 'lite' }).json?.decision, 'block', 'the same body blocks at lite without records');
  } finally { rmSync(tracked, { recursive: true, force: true }); }
  for (const make of [() => makeBodyRepo('waiver-off-unknown-'), makeNoFileConsumerRepo]) {
    const repo = make();
    try {
      assertNotBlocked(runConsumerBody(repo, waived, { level: 'off' }), 'off');
      assert.equal(runConsumerBody(repo, waived, { level: 'full' }).json?.decision, 'block', 'full without a record');
    } finally { rmSync(repo, { recursive: true, force: true }); }
  }
});

// ── add-cross-repo-pr-scope-marker: the consumer gate's branch for a marker-authorized create (design D5 / D9) ──
//
// The session checkout is acme/session and the PR belongs to acme/target. `DEVPRO_CROSS_REPO_PR=acme/target`
// authorizes a create that writes a literal --repo and a literal --head and declares no DEVPRO_PR_CHECKOUT; the
// gate then treats it as remote-only. Block assertions read the reason's first line, which today is the legacy
// "--repo/-R or GH_REPO does not identify this local checkout", so a block of the old branch cannot pass them.
const MARKER = 'DEVPRO_CROSS_REPO_PR=acme/target ';
const LEGACY_CHECKOUT_MISMATCH = /does not identify this local checkout/;

function runMarkerCreate({ flags, prefix = MARKER, env = {}, declared = false }) {
  const sessionRepo = makeEvidenceRepo(CHORE_OPTIONS);
  const targetRepo = makeEvidenceRepo(CHORE_OPTIONS);
  evidenceGit(sessionRepo, ['remote', 'add', 'origin', 'https://github.com/acme/session.git']);
  evidenceGit(targetRepo, ['remote', 'add', 'origin', 'https://github.com/acme/target.git']);
  const bodyDir = makeTempDir('pr-body-gate-marker-body-');
  try {
    const bodyFile = path.join(bodyDir, 'pr-body.md');
    writeFileSync(bodyFile, VALID_PR_BODY, 'utf8');
    const checkout = declared ? `DEVPRO_PR_CHECKOUT=${targetRepo} ` : '';
    const cmd = `${prefix}${checkout}gh pr create --title "chore: x" ${flags(targetRepo)} --body-file ${bodyFile}`;
    const childEnv = { ...process.env, CODEX_CI: '', CODEX_THREAD_ID: '', DEVPRO_SENTINEL_STATE_DIR: makeTempDir('sentinel-pr-body-marker-') };
    for (const key of ['GH_REPO', 'GH_HOST', 'DEVPRO_CROSS_REPO_PR', 'DEVPRO_PR_CHECKOUT', 'DEVPRO_REPO_SCOPE_APPROVED', 'DEVPRO_HOOK_BYPASS']) delete childEnv[key];
    const result = spawnSync('node', [HOOK], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: cmd, cwd: sessionRepo } }),
      encoding: 'utf8',
      env: { ...childEnv, ...env },
    });
    let json = null;
    if (result.stdout && result.stdout.trim()) {
      try { json = JSON.parse(result.stdout); } catch { /* not JSON */ }
    }
    return { code: result.status, stdout: result.stdout, stderr: result.stderr, json };
  } finally {
    rmSync(sessionRepo, { recursive: true, force: true });
    rmSync(targetRepo, { recursive: true, force: true });
    rmSync(bodyDir, { recursive: true, force: true });
  }
}

const markerBlockFirstLine = (r, label) => {
  assert.equal(r.json?.decision, 'block', `${label}: expected a block, got ${r.stdout} ${r.stderr}`);
  const first = String(r.json.reason).split('\n')[0];
  assert.match(first, /^Consumer pre-PR checks gate: /, label);
  return first;
};

test('[Scenario: pre-tool-mechanical-gates :: An undeclared marker-authorized create is remote-only] [WhenThen: 1] a literal --repo and --head with the marker pass the consumer gate (through the hook)', () => {
  assertNotBlocked(runMarkerCreate({ flags: () => '--repo acme/target --head some-branch' }), 'marker create with --repo and --head');
  assertNotBlocked(runMarkerCreate({ flags: () => '-R acme/target --head some-branch' }), 'marker create with -R and --head');
});

test('[Scenario: pre-tool-mechanical-gates :: A marker-authorized create must write its repository and head] [WhenThen: 1] a missing or non-literal --head names the head (through the hook)', () => {
  for (const [label, flags] of [['no --head', () => '--repo acme/target'], ['non-literal --head', () => '--repo acme/target --head "$BRANCH"']]) {
    const r = runMarkerCreate({ flags });
    const first = markerBlockFirstLine(r, label);
    assert.doesNotMatch(first, LEGACY_CHECKOUT_MISMATCH, `${label}: the block is about the head, not a checkout mismatch`);
    assert.match(first, /literal/i, label);
    assert.match(first, /--head/, label);
    assert.match(r.json.reason, /DEVPRO_PR_CHECKOUT=<absolute[- ]checkout>/, `${label}: points to the declared checkout for local evidence`);
  }
});

test('[Scenario: pre-tool-mechanical-gates :: A marker-authorized create must write its repository and head] [WhenThen: 1] only an inherited GH_REPO names the missing --repo (through the hook)', () => {
  const r = runMarkerCreate({ flags: () => '--head some-branch', env: { GH_REPO: 'acme/target' } });
  const first = markerBlockFirstLine(r, 'inherited GH_REPO');
  assert.doesNotMatch(first, LEGACY_CHECKOUT_MISMATCH, 'the block is about the missing --repo, not a checkout mismatch');
  assert.match(first, /literal/i);
  assert.match(first, /--repo/);
  assert.match(r.json.reason, /DEVPRO_PR_CHECKOUT=<absolute[- ]checkout>/);
});

test('[Scenario: pre-tool-mechanical-gates :: A fork head is not authorized by the marker] [WhenThen: 1] an owner:branch head names the fork form, and the unmarked create keeps blocking (through the hook)', () => {
  const flags = () => '--repo acme/target --head contributor:branch';
  const marked = runMarkerCreate({ flags });
  const first = markerBlockFirstLine(marked, 'marker with a fork head');
  assert.doesNotMatch(first, LEGACY_CHECKOUT_MISMATCH, 'the block names the fork head form');
  assert.match(first, /owner:branch/);
  assert.equal(runMarkerCreate({ flags, prefix: '' }).json?.decision, 'block', 'the same create without the marker blocks');
});

test('[Scenario: pre-tool-mechanical-gates :: The marker does not relax a declared checkout] [WhenThen: 1] a declared checkout of another repository keeps the declared contract even when the marker names --repo (through the hook)', () => {
  const r = runMarkerCreate({
    prefix: 'DEVPRO_CROSS_REPO_PR=acme/other ',
    declared: true,
    flags: () => `--repo acme/other --head ${CHORE_OPTIONS.branch}`,
  });
  const first = markerBlockFirstLine(r, 'declared checkout, marker names another repository');
  assert.match(first, LEGACY_CHECKOUT_MISMATCH, 'the declared contract: --repo must name the declared checkout origin');
  assert.doesNotMatch(r.json.reason, /Cross-repo PR write gate/, 'the marker did not turn the write into the remote-only allowance');
});

test('[Scenario: pre-tool-mechanical-gates :: A declared submodule worktree keeps the declared contract] [WhenThen: 1] a declared checkout is judged identically with and without the marker (through the hook, regression lock)', () => {
  const flags = () => `--repo acme/target --head ${CHORE_OPTIONS.branch}`;
  const plain = runMarkerCreate({ prefix: '', declared: true, flags });
  const marked = runMarkerCreate({ declared: true, flags });
  assertNotBlocked(plain, 'declared checkout without the marker');
  assertNotBlocked(marked, 'declared checkout with the marker');
  assert.equal(JSON.stringify(marked.json), JSON.stringify(plain.json));
});
