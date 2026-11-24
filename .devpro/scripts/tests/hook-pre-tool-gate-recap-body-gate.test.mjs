/**
 * hook-pre-tool-gate-recap-body-gate.test.mjs
 *
 * Tests for the Gate 4b (Recap body lint) in pre-tool-gate.mjs.
 *
 * Tests invoke the hook with synthetic PreToolUse JSON payloads, using
 * mkdtempSync-isolated body files. Each test creates a temp dir and cleans up
 * via try/finally rmSync.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from './lib/tmp.mjs';
import { resolveReminderSession } from '../hooks/lib/session-reminder.mjs';
import { advisoryText } from './lib/hook-harness.mjs';

const HOOK = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../hooks/pre-tool-gate.mjs'
);

// ── Canonical valid Recap body ─────────────────────────────────────────────

const VALID_RECAP_BODY = `
## Branch
chore/some-change (PR #42, merged → main)

## 完成項
- 實作了某功能

## Requirement Ledger Completion
- disposition counts: implemented 1, partial 0, deferred 0, rejected 0, moved-to-issue 0
- non-implemented rows: N/A

## Token 回顧
- host: claude-code
- session: 15799085-98b0-480b-a930-1ae9140a1dc9
- source: 精準命中
- totals: input 12000 / output 8000 / cache_read 4000 / cache_creation 0
- cost_usd: 1.23
- gaps: 無

| 起 | 耗時 | 誰 | 項目 | input | output | cache_read | cache_creation |
|---|---|---|---|---|---|---|---|
| 10:00:00 | 5s | main | 實作 T1 | 6000 | 4000 | 2000 | 0 |

## 版本資訊
Rules: v6.35.0 · Tool: Claude Code / claude-sonnet-4-6
`.trim();

const INVALID_RECAP_BODY_MISSING_SECTION = `
## Branch
chore/some-change (PR #42, merged → main)

## Requirement Ledger Completion
- disposition counts: implemented 1, partial 0, deferred 0, rejected 0, moved-to-issue 0
- non-implemented rows: N/A

## 版本資訊
Rules: v6.35.0 · Tool: Claude Code / claude-sonnet-4-6
`.trim();
// Missing ## 完成項

const INVALID_RECAP_BODY_LINEAGE_CLAIM = VALID_RECAP_BODY.replace(
  '- gaps: 無',
  [
    '- schema: devpro-lineage-usage-report/v1',
    '- lookup: exact',
    '- scope: current-change',
    '- coverage: lineage-complete',
    '- terminality: terminal',
    '- reconciliation: reconciled',
    '- claims: current-change, lineage-complete, final, reconciled',
    '- root_sessions: 1',
    '- descendant_sessions: 0',
    '- external_reviewer_sessions: 0',
    '- dispatch_rows: 0',
    '- spawn_events: 1',
    '- root_totals: input 12000 / output 8000',
    '- descendant_totals: input 0 / output 0',
    '- external_reviewer_totals: input 0 / output 0',
    '- lineage_totals: input 12000 / output 8000',
    '- efficiency_verdict: not-comparable',
    '- baseline: N/A: no equivalent baseline measurement',
    '- quota_impact: N/A: provider does not expose quota impact',
    '- quota_authority: N/A: provider does not expose quota authority',
    '- gaps: none',
  ].join('\n'),
);

const INVALID_RECAP_BODY_NA_LINEAGE_CLAIM = INVALID_RECAP_BODY_LINEAGE_CLAIM.replace(
  '- source: 精準命中',
  '- source: N/A: host does not expose usage data',
);

/**
 * Run the hook with the given payload and environment.
 * Returns { code, stdout, stderr, json }.
 */
function runHook(payload, extraEnv = {}) {
  const result = spawnSync('node', [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      DEVPRO_AGENT_RULES_LEVEL: 'full',
      CODEX_CI: '',
      CODEX_THREAD_ID: '',
      // Isolate sentinel state
      DEVPRO_SENTINEL_STATE_DIR: makeTempDir('sentinel-recap-test-'),
      ...extraEnv,
    },
  });
  let json = null;
  if (result.stdout && result.stdout.trim()) {
    try { json = JSON.parse(result.stdout); } catch { /* not JSON */ }
  }
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

function assertRecapAdvisory(r, message) {
  assert.ok(r.json, `Expected JSON output, got: stdout=${r.stdout}`);
  assert.notEqual(r.json.decision, 'block', message || `Expected recap advisory, got: ${JSON.stringify(r.json)}`);
  assert.match(advisoryText(r.json), /Recap body lint gate/);
}

/**
 * Build a gh api graphql createDiscussion command with body from a file.
 */
function makeCreateDiscussionCmd(bodyFilePath) {
  return (
    `gh api graphql -F query=@/tmp/query.graphql ` +
    `-F repositoryId=R_123 ` +
    `-F categoryId=C_123 ` +
    `-F title="Recap" ` +
    `-F body="$(cat ${bodyFilePath})" ` +
    `... createDiscussion(input:`
  );
}

/**
 * Build a gh api graphql createDiscussion command with body from a file
 * and a custom title (for title lint tests).
 */
function makeCreateDiscussionCmdWithTitle(bodyFilePath, title) {
  return (
    `gh api graphql -F query=@/tmp/query.graphql ` +
    `-F repositoryId=R_123 ` +
    `-F categoryId=C_123 ` +
    `-F title="${title}" ` +
    `-F body="$(cat ${bodyFilePath})" ` +
    `... createDiscussion(input:`
  );
}

function makeUpdateDiscussionCmd(bodyFilePath) {
  return (
    `gh api graphql -F query=@/tmp/query.graphql ` +
    `-F discussionId=D_456 ` +
    `-F body="$(cat ${bodyFilePath})" ` +
    `... updateDiscussion(input:`
  );
}

/**
 * Canonical session-recap.md form: the createDiscussion mutation lives INSIDE a
 * single-quoted `-f query='…'` GraphQL argument (NOT a bare trailing token), and
 * the body comes via `-F body=@<file>`. This is the real-world shape Gate 4b must
 * still fire on — the shape PR #1183 cross-model proved a naive segment-filter
 * trigger would silently miss (createDiscussion gets stripped to __QUOTED__).
 */
function makeCanonicalCreateDiscussionCmd(bodyFilePath, title = '[devpro-agent-rules] x 2026-06-07') {
  return (
    `gh api graphql ` +
    `-F repoId=R_1 -F categoryId=C_1 -F title="${title}" ` +
    `-F body=@${bodyFilePath} ` +
    `-f query='mutation($repoId: ID!, $categoryId: ID!, $title: String!, $body: String!) ` +
    `{ createDiscussion(input: { repositoryId: $repoId, categoryId: $categoryId, title: $title, body: $body }) { discussion { url } } }'`
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test('case 1 (PASS): valid body + createDiscussion → exit 0, no block', () => {
  const tmpDir = makeTempDir('recap-gate-t1-');
  try {
    const bodyFile = path.join(tmpDir, 'recap.md');
    writeFileSync(bodyFile, VALID_RECAP_BODY, 'utf8');
    const cmd = makeCreateDiscussionCmd(bodyFile);
    const payload = { tool_name: 'Bash', tool_input: { command: cmd, cwd: tmpDir } };
    const r = runHook(payload);
    assert.equal(r.code, 0, `Expected exit 0, got ${r.code}\nstderr: ${r.stderr}`);
    // Should not emit a block decision
    assert.ok(
      !r.json || r.json.decision !== 'block',
      `Should not block valid recap body\njson: ${JSON.stringify(r.json)}`
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('case 2 (ADVISORY): body 缺 ## 完成項 + createDiscussion → advisory, context 含 ## 完成項', () => {
  const tmpDir = makeTempDir('recap-gate-t2-');
  try {
    const bodyFile = path.join(tmpDir, 'recap.md');
    writeFileSync(bodyFile, INVALID_RECAP_BODY_MISSING_SECTION, 'utf8');
    const cmd = makeCreateDiscussionCmd(bodyFile);
    const payload = { tool_name: 'Bash', tool_input: { command: cmd, cwd: tmpDir } };
    const r = runHook(payload);
    assert.equal(r.code, 0, `Hook exits 0 (advisory emitted via stdout JSON)`);
    assertRecapAdvisory(r);
    assert.ok(
      advisoryText(r.json).includes('## 完成項'),
      `Advisory should mention '## 完成項'\ncontext: ${advisoryText(r.json)}`
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('T10 claim-integrity integration RED: hook surfaces descendant evidence contradiction', () => {
  const tmpDir = makeTempDir('recap-gate-lineage-red-');
  try {
    const bodyFile = path.join(tmpDir, 'recap.md');
    writeFileSync(bodyFile, INVALID_RECAP_BODY_LINEAGE_CLAIM, 'utf8');
    const cmd = makeCanonicalCreateDiscussionCmd(bodyFile);
    const r = runHook({ tool_name: 'Bash', tool_input: { command: cmd, cwd: tmpDir } });
    assertRecapAdvisory(r);
    assert.match(advisoryText(r.json), /descendant_sessions|descendant evidence/i);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('T10 claim-integrity integration: source N/A cannot bypass lineage contradictions', () => {
  const tmpDir = makeTempDir('recap-gate-lineage-na-red-');
  try {
    const bodyFile = path.join(tmpDir, 'recap.md');
    writeFileSync(bodyFile, INVALID_RECAP_BODY_NA_LINEAGE_CLAIM, 'utf8');
    const cmd = makeCanonicalCreateDiscussionCmd(bodyFile);
    const r = runHook({ tool_name: 'Bash', tool_input: { command: cmd, cwd: tmpDir } });
    assertRecapAdvisory(r);
    assert.match(advisoryText(r.json), /descendant_sessions|descendant evidence/i);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('case 3 (NO INTERFERENCE): non-createDiscussion cmd (git status) → exit 0, no block', () => {
  const tmpDir = makeTempDir('recap-gate-t3-');
  try {
    const payload = { tool_name: 'Bash', tool_input: { command: 'git status', cwd: tmpDir } };
    const r = runHook(payload);
    assert.equal(r.code, 0);
    assert.ok(
      !r.json || r.json.decision !== 'block',
      `git status should not trigger recap body lint\njson: ${JSON.stringify(r.json)}`
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('case 4 (ADVISORY on updateDiscussion): body 缺 ## 完成項 + updateDiscussion → advisory', () => {
  const tmpDir = makeTempDir('recap-gate-t4-');
  try {
    const bodyFile = path.join(tmpDir, 'recap.md');
    writeFileSync(bodyFile, INVALID_RECAP_BODY_MISSING_SECTION, 'utf8');
    const cmd = makeUpdateDiscussionCmd(bodyFile);
    const payload = { tool_name: 'Bash', tool_input: { command: cmd, cwd: tmpDir } };
    const r = runHook(payload);
    assert.equal(r.code, 0);
    assertRecapAdvisory(r, `Expected advisory on updateDiscussion with invalid body`);
    assert.ok(
      advisoryText(r.json).includes('## 完成項'),
      `Advisory should mention '## 完成項'\ncontext: ${advisoryText(r.json)}`
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('case 5 (fail-open on inline body): -F body="literal string" no $(cat ...) → exit 0 not blocked', () => {
  const tmpDir = makeTempDir('recap-gate-t5-');
  try {
    // Inline body without $(cat ...) pattern — should fail-open (not block)
    const cmd =
      `gh api graphql -F query=@/tmp/q.graphql ` +
      `-F body="## Branch\\nsome-branch" ` +
      `... createDiscussion(input:`;
    const payload = { tool_name: 'Bash', tool_input: { command: cmd, cwd: tmpDir } };
    const r = runHook(payload);
    assert.equal(r.code, 0);
    assert.ok(
      !r.json || r.json.decision !== 'block',
      `Inline body should fail-open (not block)\njson: ${JSON.stringify(r.json)}`
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── round-4 audit B 15a/15b: --field (long form of -F) + body=@file form ──
test('case 15a (ADVISORY): --field body="$(cat <invalid>)" → advisory (long form of -F)', () => {
  const tmpDir = makeTempDir('recap-gate-field-');
  try {
    const bodyFile = path.join(tmpDir, 'recap.md');
    writeFileSync(bodyFile, INVALID_RECAP_BODY_MISSING_SECTION, 'utf8');
    const cmd =
      'gh api graphql -F query=@/tmp/query.graphql -F discussionId=D_1 ' +
      '--field body="$(cat ' + bodyFile + ')" ... createDiscussion(input:';
    const r = runHook({ tool_name: 'Bash', tool_input: { command: cmd, cwd: tmpDir } });
    assertRecapAdvisory(r, `--field body must be linted, got: ${JSON.stringify(r.json)}`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('case 15b (ADVISORY): -F body=@<invalid-file> → advisory (gh @file form)', () => {
  const tmpDir = makeTempDir('recap-gate-at-');
  try {
    const bodyFile = path.join(tmpDir, 'recap.md');
    writeFileSync(bodyFile, INVALID_RECAP_BODY_MISSING_SECTION, 'utf8');
    const cmd =
      'gh api graphql -F query=@/tmp/query.graphql -F discussionId=D_1 ' +
      '-F body=@' + bodyFile + ' ... createDiscussion(input:';
    const r = runHook({ tool_name: 'Bash', tool_input: { command: cmd, cwd: tmpDir } });
    assertRecapAdvisory(r, `-F body=@file must be linted, got: ${JSON.stringify(r.json)}`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('case 15c (PASS): -F body=@<valid-file> → exit 0, no advisory', () => {
  const tmpDir = makeTempDir('recap-gate-at-valid-');
  try {
    const bodyFile = path.join(tmpDir, 'recap.md');
    writeFileSync(bodyFile, VALID_RECAP_BODY, 'utf8');
    const cmd =
      'gh api graphql -F query=@/tmp/query.graphql -F discussionId=D_1 ' +
      '-F body=@' + bodyFile + ' ... updateDiscussion(input:';
    const r = runHook({ tool_name: 'Bash', tool_input: { command: cmd, cwd: tmpDir } });
    assert.equal(r.code, 0);
    assert.equal(r.json, null, `valid @file recap body should be quiet, got: ${JSON.stringify(r.json)}`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Title lint gate cases ──────────────────────────────────────────────────────

test('title-bad: VALID body + non-canonical title → exit 0, no block, advisory contains title hint', () => {
  const tmpDir = makeTempDir('recap-gate-title-bad-');
  try {
    const bodyFile = path.join(tmpDir, 'recap.md');
    writeFileSync(bodyFile, VALID_RECAP_BODY, 'utf8');
    const cmd = makeCreateDiscussionCmdWithTitle(bodyFile, 'Session Recap: bugfix/x (PR #1)');
    const payload = { tool_name: 'Bash', tool_input: { command: cmd, cwd: tmpDir } };
    const r = runHook(payload);
    assert.equal(r.code, 0, `Expected exit 0, got ${r.code}\nstderr: ${r.stderr}`);
    assert.ok(r.json, `Expected JSON output\nstdout: ${r.stdout}`);
    assert.notEqual(r.json.decision, 'block', `Title lint must not block\njson: ${JSON.stringify(r.json)}`);
    assert.ok(
      advisoryText(r.json).includes('Recap title format'),
      `Advisory should contain 'Recap title format'\ncontext: ${advisoryText(r.json)}`
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('title-good: VALID body + canonical title → exit 0, no title advisory', () => {
  const tmpDir = makeTempDir('recap-gate-title-good-');
  try {
    const bodyFile = path.join(tmpDir, 'recap.md');
    writeFileSync(bodyFile, VALID_RECAP_BODY, 'utf8');
    const cmd = makeCreateDiscussionCmdWithTitle(bodyFile, '[devpro-agent-rules] x 2026-06-07');
    const payload = { tool_name: 'Bash', tool_input: { command: cmd, cwd: tmpDir } };
    const r = runHook(payload);
    assert.equal(r.code, 0, `Expected exit 0, got ${r.code}\nstderr: ${r.stderr}`);
    // Both body and title are valid → hook should be quiet (null JSON)
    assert.ok(
      !r.json || !advisoryText(r.json).includes('Recap title format'),
      `Valid title should not emit title advisory\njson: ${JSON.stringify(r.json)}`
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('no-body-no-titlelint: inline body (no $(cat)/@file) + non-canonical title → fail-open, no title advisory', () => {
  const tmpDir = makeTempDir('recap-gate-inline-');
  try {
    // Inline body without $(cat ...) — body lint fails-open (returns null from checkRecapBodyLint)
    // Title lint must also be skipped (no body file extracted = not a verified recap).
    const cmd =
      `gh api graphql -F query=@/tmp/q.graphql ` +
      `-F title="Session Recap: bugfix/x (PR #1)" ` +
      `-F body="## Branch\\nsome-branch" ` +
      `... createDiscussion(input:`;
    const payload = { tool_name: 'Bash', tool_input: { command: cmd, cwd: tmpDir } };
    const r = runHook(payload);
    assert.equal(r.code, 0, `Expected exit 0\nstderr: ${r.stderr}`);
    assert.ok(
      !r.json || !advisoryText(r.json).includes('Recap title format'),
      `Inline body should not trigger title lint\njson: ${JSON.stringify(r.json)}`
    );
    assert.ok(
      !r.json || r.json.decision !== 'block',
      `Must not block on inline body\njson: ${JSON.stringify(r.json)}`
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('body-bad-and-title-bad: invalid body + non-canonical title → advisory contains both body and title hints, no block', () => {
  const tmpDir = makeTempDir('recap-gate-both-bad-');
  try {
    const bodyFile = path.join(tmpDir, 'recap.md');
    writeFileSync(bodyFile, INVALID_RECAP_BODY_MISSING_SECTION, 'utf8');
    const cmd = makeCreateDiscussionCmdWithTitle(bodyFile, 'Session Recap: bugfix/x (PR #1)');
    const payload = { tool_name: 'Bash', tool_input: { command: cmd, cwd: tmpDir } };
    const r = runHook(payload);
    assert.equal(r.code, 0, `Expected exit 0\nstderr: ${r.stderr}`);
    assert.ok(r.json, `Expected JSON output\nstdout: ${r.stdout}`);
    assert.notEqual(r.json.decision, 'block', `Must not block\njson: ${JSON.stringify(r.json)}`);
    const advisory = advisoryText(r.json);
    assert.ok(
      advisory.includes('Recap body lint gate'),
      `Advisory should contain body hint 'Recap body lint gate'\ncontext: ${advisory}`
    );
    assert.ok(
      advisory.includes('Recap title format'),
      `Advisory should contain title hint 'Recap title format'\ncontext: ${advisory}`
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── segment-filter trigger-skip (twin of Gate 4c fix) ──────────────────────
test('case 16a (segment-filter trigger-skip): createDiscussion + -F body=@ only inside a heredoc body does NOT fire Gate 4b', () => {
  // Trigger detection runs through gateCommandSegmentText, which strips heredoc
  // bodies. A `createDiscussion(input:` mention (and an embedded `-F body=@`)
  // that live ONLY inside a heredoc-assembled body file — e.g. a sticky/recap
  // body that documents a gh-api example — must NOT fire the gate. The outer
  // command is `cat >`, not a real mutation. Pre-fix, the raw-cmd trigger would
  // match and then try to read the embedded (nonexistent) path → spurious
  // "Recap body file unreadable" advisory.
  const tmpDir = makeTempDir('recap-gate-16a-');
  try {
    const outFile = path.join(tmpDir, 'sticky.md');
    const cmd = [
      `cat > ${outFile} <<'EOF'`,
      '## Cross-Model Review',
      'Example of writing a recap: `gh api graphql ... createDiscussion(input: ...) -F body=@/tmp/does-not-exist.md`',
      'Rules: v6.69.0 · Tool: codex · Model: GPT-5',
      'EOF',
    ].join('\n');
    const payload = { tool_name: 'Bash', tool_input: { command: cmd, cwd: tmpDir } };
    const r = runHook(payload);
    assert.equal(r.code, 0, `Expected exit 0\nstderr: ${r.stderr}`);
    assert.ok(
      !r.json || r.json.decision !== 'block',
      `Heredoc-only createDiscussion must not block\njson: ${JSON.stringify(r.json)}`
    );
    // Must produce NO recap advisory at all — neither lint nor "unreadable".
    const advisory = advisoryText(r.json);
    assert.ok(
      !advisory.includes('Recap body lint gate') && !advisory.includes('Recap body file unreadable'),
      `createDiscussion inside a heredoc should not fire Gate 4b\ncontext: ${advisory}`
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('case 16b (regression — canonical quoted-query form): createDiscussion INSIDE -f query=\'…\' with invalid body still fires', () => {
  // The load-bearing regression guard (PR #1183 cross-model). The canonical
  // session-recap.md command puts `createDiscussion` inside a single-quoted
  // `-f query='…'` GraphQL argument. A naive segment-filter trigger would strip
  // that to __QUOTED__ and silently STOP linting real recap bodies. The gate
  // MUST still fire here: trigger matched on raw cmd + a real `gh api` verb in
  // the command segment.
  const tmpDir = makeTempDir('recap-gate-16b-');
  try {
    const bodyFile = path.join(tmpDir, 'recap.md');
    writeFileSync(bodyFile, INVALID_RECAP_BODY_MISSING_SECTION, 'utf8');
    const cmd = makeCanonicalCreateDiscussionCmd(bodyFile);
    const r = runHook({ tool_name: 'Bash', tool_input: { command: cmd, cwd: tmpDir } });
    assertRecapAdvisory(r, `Canonical -f query='…createDiscussion…' must still be linted, got: ${JSON.stringify(r.json)}`);
    assert.ok(
      advisoryText(r.json).includes('## 完成項'),
      `Advisory should mention '## 完成項'\ncontext: ${advisoryText(r.json)}`
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('case 16c (canonical quoted-query form, valid body): passes silently', () => {
  // Canonical recap command with a VALID body file → gate runs (gh api verb +
  // createDiscussion in query) and the lint passes → no advisory, no block.
  const tmpDir = makeTempDir('recap-gate-16c-');
  try {
    const bodyFile = path.join(tmpDir, 'recap.md');
    writeFileSync(bodyFile, VALID_RECAP_BODY, 'utf8');
    const cmd = makeCanonicalCreateDiscussionCmd(bodyFile);
    const r = runHook({ tool_name: 'Bash', tool_input: { command: cmd, cwd: tmpDir } });
    assert.equal(r.code, 0, `Expected exit 0\nstderr: ${r.stderr}`);
    assert.equal(r.json, null, `valid canonical recap body should be quiet, got: ${JSON.stringify(r.json)}`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('case 16c-lease: outgoing createDiscussion leases only own session without recording success', () => {
  const tmpDir = makeTempDir('recap-gate-16c-lease-');
  try {
    const bodyFile = path.join(tmpDir, 'recap.md');
    const scopedRoot = path.join(tmpDir, 'scoped');
    const writtenDir = path.join(tmpDir, 'written');
    const session = resolveReminderSession({session_id: 'lease-owned'}, {DEVPRO_HOOK_HOST: 'test'});
    const other = resolveReminderSession({session_id: 'lease-other'}, {DEVPRO_HOOK_HOST: 'test'});
    const files = [session, other].map((owner) => path.join(scopedRoot, owner.key, 'recap-work.json'));
    for (const [n, owner] of [session, other].entries()) {
      mkdirSync(path.dirname(files[n]), {recursive: true});
      writeFileSync(files[n], JSON.stringify([{sessionKey: owner.key, branch: 'chore/lease-me', changeName: 'lease-me', prNumber: '', merged: true, classification: 'B'}]));
    }
    const otherBefore = readFileSync(files[1], 'utf8');
    writeFileSync(bodyFile, VALID_RECAP_BODY, 'utf8');
    const cmd = makeCanonicalCreateDiscussionCmd(bodyFile, '[devpro-agent-rules] lease-me 2026-06-29');
    const r = runHook({session_id: session.sessionId, tool_name: 'Bash', tool_input: {command: cmd, cwd: tmpDir}}, {
      DEVPRO_HOOK_HOST: 'test', DEVPRO_SESSION_REMINDER_STATE_DIR: scopedRoot, DEVPRO_RECAP_WRITTEN_DIR: writtenDir,
    });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json, null);
    assert.ok(JSON.parse(readFileSync(files[0], 'utf8'))[0].inProgressAt > 0);
    assert.equal(readFileSync(files[1], 'utf8'), otherBefore);
    assert.equal(existsSync(writtenDir), false, 'PreToolUse cannot confirm Discussion success');
  } finally {rmSync(tmpDir, {recursive: true, force: true});}
});

test('case 16d (mixed-edge): createDiscussion in heredoc + UNRELATED real gh api in same compound → does NOT fire', () => {
  // The PR #1183 cross-model Suggestion. The mutation token lives in a heredoc
  // body being written to a file, while a SEPARATE, unrelated real `gh api`
  // command runs later in the same compound. Guards (1) raw-token and (2)
  // gh-api-verb both pass, but guard (3) — token must be OUTSIDE a heredoc-body
  // segment — stops the false-fire so no path is extracted from the heredoc.
  const tmpDir = makeTempDir('recap-gate-16d-');
  try {
    const ghost = path.join(tmpDir, 'ghost.md'); // referenced inside heredoc, never created
    const cmd = [
      `cat > ${path.join(tmpDir, 'note.md')} <<'EOF'`,
      `Example: createDiscussion(input: ...) with -F body=@${ghost}`,
      'EOF',
      `gh api /repos/o/r/issues -F body=@${path.join(tmpDir, 'unrelated.md')}`,
    ].join('\n');
    const r = runHook({ tool_name: 'Bash', tool_input: { command: cmd, cwd: tmpDir } });
    assert.equal(r.code, 0, `Expected exit 0\nstderr: ${r.stderr}`);
    assert.ok(
      !r.json || r.json.decision !== 'block',
      `mixed-edge must not block\njson: ${JSON.stringify(r.json)}`
    );
    const advisory = advisoryText(r.json);
    assert.ok(
      !advisory.includes('Recap body lint gate') && !advisory.includes('Recap body file unreadable'),
      `heredoc-only createDiscussion + unrelated gh api must not fire Gate 4b\ncontext: ${advisory}`
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('case 16e (FP): inline recap body text mentioning -F body=@file is not treated as body source', () => {
  const tmpDir = makeTempDir('recap-gate-16e-');
  try {
    const ghost = path.join(tmpDir, 'missing-recap-body.md');
    const cmd =
      `gh api graphql ` +
      `-F repoId=R_1 -F categoryId=C_1 -F title="[devpro-agent-rules] x 2026-06-07" ` +
      `-F body="Documented example: gh api graphql -F body=@${ghost}" ` +
      `-f query='mutation($repoId: ID!, $categoryId: ID!, $title: String!, $body: String!) ` +
      `{ createDiscussion(input: { repositoryId: $repoId, categoryId: $categoryId, title: $title, body: $body }) { discussion { url } } }'`;
    const r = runHook({ tool_name: 'Bash', tool_input: { command: cmd, cwd: tmpDir } });
    assert.equal(r.code, 0, `Expected exit 0\nstderr: ${r.stderr}`);
    assert.ok(
      !r.json || r.json.decision !== 'block',
      `inline recap body example must not block\njson: ${JSON.stringify(r.json)}`
    );
    const advisory = advisoryText(r.json);
    assert.ok(
      !advisory.includes('Recap body lint gate') &&
        !advisory.includes('Recap body file unreadable') &&
        !advisory.includes('Recap title format'),
      `quoted -F body=@ text must not be read as recap body carrier\ncontext: ${advisory}`
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
