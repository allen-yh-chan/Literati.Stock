/**
 * pre-pr-body-template-check.test.mjs
 *
 * Tests for .devpro/scripts/pre-pr-body-template-check.mjs
 *
 * Fixture bodies are inline strings to avoid scattered fixture files.
 * Script is invoked via spawnSync with --body-file <tmpfile>.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync as readFileSyncRaw, writeFileSync, rmSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeTempDir } from './lib/tmp.mjs';
import { withChangeUsageStateDir } from './lib/change-usage-fixtures.mjs';
import { appendChangeUsageOverride } from '../hooks/lib/change-usage-checkpoint.mjs';

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../pre-pr-body-template-check.mjs'
);
// cwd-independent repo-relative reads (SSOT in tests/lib/repo-root.mjs):
// repo-level files (.github/PULL_REQUEST_TEMPLATE.md, .claude/,
// .devpro/agent-rules/) must resolve via repoPath(), not process.cwd() —
// running from .devpro/scripts/ otherwise yields ENOENT (.devpro/scripts/.github/...).
import { repoPath } from './lib/repo-root.mjs';
import {
  PR_EVIDENCE_SECTION_MAX_BYTES,
  PR_CHANGE_CONTEXT_MAX_BYTES,
} from '../lib/pr-body-evidence-rules.mjs';
import { canonicalEmbeddedReviewMaterialProof } from '../second-review-material-contract.mjs';

// A Windows checkout with core.autocrlf=true has CRLF in tracked Markdown, while every anchor in this file is LF.
// Text reads are normalised once here so each assertion sees the same bytes on every platform.
const readFileSync = (file, encoding) => {
  const value = readFileSyncRaw(file, encoding);
  return typeof value === 'string' ? value.replace(/\r\n/g, '\n') : value;
};
const PRECISE_CARRIER_GLOBS_RE =
  /\.devpro\/agent-rules\/\*\.md.*scenarios\/scenario-\*\.md.*\.devpro\/scripts\/hooks\/\*\.mjs.*\.devpro\/scripts\/hooks\/lib\/\*\.mjs.*\.claude\/agents\/\*\.md.*\.claude\/commands\/\*\.md/s;
const BROAD_CARRIER_GLOBS_RE =
  /\.devpro\/scripts\/hooks\/\*\*|\.devpro\/agent-rules\/\*\*|\.claude\/agents\/\*\*|\.claude\/commands\/\*\*/;
const WALKTHROUGH_EXACT_STATES = [
  'executed PASS',
  'skipped by AI decision: <reason>',
  'skipped per user decision: <reason>',
  'N/A (non-enforcement-carrier change)',
];

function walkthroughContract(content, carrier) {
  if (carrier.endsWith('pre-pr/SKILL.md')) {
    const start = content.indexOf('#### Part 2: Bounded Decision and User Fallback');
    const end = content.indexOf('#### Part 3: Safety Net', start);
    assert.ok(start >= 0 && end > start, `${carrier} missing bounded Scenario Walkthrough decision block`);
    return content.slice(start, end);
  }

  const heading = '## Scenario Walkthrough\n';
  const start = content.indexOf(heading);
  assert.ok(start >= 0, `${carrier} missing Scenario Walkthrough status block`);
  const bodyStart = start + heading.length;
  const nextHeadingOffset = content.slice(bodyStart).search(/^## /m);
  return nextHeadingOffset < 0
    ? content.slice(bodyStart)
    : content.slice(bodyStart, bodyStart + nextHeadingOffset);
}

function assertExactWalkthroughStates(content, carrier) {
  const contract = walkthroughContract(content, carrier);
  const present = WALKTHROUGH_EXACT_STATES.filter((state) => contract.includes(state));
  assert.deepEqual(present, WALKTHROUGH_EXACT_STATES, `${carrier} Scenario Walkthrough state parity mismatch`);

  const outputTokens = [...contract.matchAll(/→[^\n]*(?:record|記錄?|記)\s+`([^`]+)`/g)]
    .map((match) => match[1]);
  for (const token of outputTokens) {
    assert.ok(WALKTHROUGH_EXACT_STATES.includes(token), `${carrier} has unsupported fifth Scenario Walkthrough state "${token}"`);
  }
}

function assertStateRemovalFails(content, carrier) {
  const contract = walkthroughContract(content, carrier);
  for (const state of WALKTHROUGH_EXACT_STATES) {
    const mutated = content.replace(contract, contract.split(state).join('<removed-state>'));
    assert.throws(
      () => assertExactWalkthroughStates(mutated, carrier),
      /state parity mismatch/,
      `${carrier} guard accepted removal of "${state}"`
    );
  }
}

/** Write a body string to a temp file; caller is responsible for cleanup. */
function writeTempBody(content) {
  const dir = makeTempDir('pr-body-check-');
  const file = path.join(dir, 'body.md');
  writeFileSync(file, content, 'utf8');
  return { dir, file };
}

function run(file) {
  // Hermetic cwd/branch so live change-usage checkpoints on the checked-out
  // worktree (non-empty overrides[]) cannot poison N/A fixture bodies.
  const cwd = makeTempDir('pr-body-check-cwd-');
  try {
    return spawnSync(
      'node',
      [SCRIPT, '--body-file', file, '--cwd', cwd, '--branch', 'chore/hermetic-pr-body-check'],
      { encoding: 'utf8' },
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// ── Canonical full-body fixture ────────────────────────────────────────────────

const FULL_BODY = `
## OpenSpec
- change: \`openspec/changes/fix-pre-pr-pr-template-routing/\`
- tasks.md: all checked ✓
- archive: done

## Change Context
- 改什麼：example landing
- 目的：example purpose

## Manual Test
- N/A: rule-only grep change; no human UI path

## Requirement Ledger Completion
- disposition counts: implemented 1, partial 0, deferred 0, rejected 0, moved-to-issue 0
- non-implemented rows: N/A
- coverage: implemented/partial rows have \`[Req: R#]\` task evidence; unknown \`[Req]\` refs: none

## Test Evidence
- 指令：\`node .devpro/scripts/run-test-suite.mjs --tier all\`
- 結果：\`passed 5, failed 0, skipped 0\`
- 覆蓋：\`lint-spec-shall-must: 12 requirement(s) scanned; whitespace: pass (3 file(s) vs origin/main)\`
- QA 範圍：\`openspec/changes/fix-pre-pr-pr-template-routing/qa-test-scope.md\`
- **驗收證據**（3 條對應 proposal Target state）：
  - [ ] script exit 0 for valid PR body
  - [ ] script exit 1 + stderr lists missing phrases
  - [ ] script exit 2 for empty input

## Scenario Walkthrough
- Status: N/A (non-enforcement-carrier change)
- Evidence: N/A

## Cost Circuit Breaker Overrides
- N/A

## Security Review
- SQL injection：已檢查（無字串拼接）
- PII：已檢查（無外洩）

## Conditional Fields
- 第三方套件：N/A
- DB schema：N/A
- issue：Fixes #123
`.trim();

// ── Tests ──────────────────────────────────────────────────────────────────────

test('case 1 (PASS): full canonical body → exit 0, stdout OK', () => {
  const { dir, file } = writeTempBody(FULL_BODY);
  try {
    const r = run(file);
    assert.equal(r.status, 0, `Expected exit 0, got ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /OK: PR body template canonical phrases present/);
    assert.doesNotMatch(r.stderr, /ADVISORY:.*覆蓋：/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 1a (ADVISORY): missing 覆蓋： → exit 0 with advisory stderr (not hard fail)', () => {
  const body = FULL_BODY.replace(/^- 覆蓋：.*\n/m, '');
  const { dir, file } = writeTempBody(body);
  try {
    const r = run(file);
    assert.equal(r.status, 0, `Expected exit 0 (advisory-only), got ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /OK: PR body template canonical phrases present/);
    assert.match(r.stderr, /ADVISORY:[\s\S]*覆蓋：/);
    assert.match(r.stderr, /advisory-only/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('case 1b (FAIL): missing ## Change Context → exit 1', () => {
  const body = FULL_BODY.replace('## Change Context', '## Context');
  const { dir, file } = writeTempBody(body);
  try {
    const r = run(file);
    assert.equal(r.status, 1, `Expected exit 1, got ${r.status}\nstderr: ${r.stderr}`);
    assert.ok(r.stderr.includes('## Change Context'), `stderr should name ## Change Context\nActual stderr: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 1c (FAIL): missing ## Manual Test → exit 1', () => {
  const body = FULL_BODY.replace('## Manual Test', '## Manual QA');
  const { dir, file } = writeTempBody(body);
  try {
    const r = run(file);
    assert.equal(r.status, 1, `Expected exit 1, got ${r.status}\nstderr: ${r.stderr}`);
    assert.ok(r.stderr.includes('## Manual Test'), `stderr should name ## Manual Test\nActual stderr: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 2 (FAIL): missing ## Test Evidence → exit 1, stderr names missing phrase', () => {
  const body = FULL_BODY.replace('## Test Evidence', '## Tests');
  const { dir, file } = writeTempBody(body);
  try {
    const r = run(file);
    assert.equal(r.status, 1, `Expected exit 1, got ${r.status}`);
    assert.match(r.stderr, /ERROR: PR body missing canonical template phrases/);
    assert.ok(
      r.stderr.includes('## Test Evidence'),
      `stderr should name missing phrase '## Test Evidence'\nActual stderr: ${r.stderr}`
    );
    assert.match(r.stderr, /Reference:.*git-pr-template-and-merge\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 3 (FAIL): has ## Test Evidence but missing 驗收證據 → exit 1, stderr names 驗收證據', () => {
  const body = FULL_BODY.replace('驗收證據', '驗收條件');
  const { dir, file } = writeTempBody(body);
  try {
    const r = run(file);
    assert.equal(r.status, 1, `Expected exit 1, got ${r.status}`);
    assert.match(r.stderr, /ERROR: PR body missing canonical template phrases/);
    assert.ok(
      r.stderr.includes('驗收證據'),
      `stderr should name missing phrase '驗收證據'\nActual stderr: ${r.stderr}`
    );
    // ## Test Evidence is present so it must NOT be listed as missing
    assert.ok(
      !r.stderr.includes('## Test Evidence'),
      `stderr should NOT list '## Test Evidence' when it is present\nActual stderr: ${r.stderr}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 3a (FAIL): missing ## Scenario Walkthrough → exit 1, stderr names missing phrase', () => {
  const body = FULL_BODY.replace('## Scenario Walkthrough', '## Walkthrough');
  const { dir, file } = writeTempBody(body);
  try {
    const r = run(file);
    assert.equal(r.status, 1, `Expected exit 1, got ${r.status}`);
    assert.match(r.stderr, /ERROR: PR body missing canonical template phrases/);
    assert.ok(
      r.stderr.includes('## Scenario Walkthrough'),
      `stderr should name missing phrase '## Scenario Walkthrough'\nActual stderr: ${r.stderr}`
    );
    assert.ok(
      !r.stderr.includes('## Test Evidence'),
      `stderr should NOT list '## Test Evidence' when it is present\nActual stderr: ${r.stderr}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 3a2 (FAIL): missing ## Cost Circuit Breaker Overrides → exit 1, stderr names missing phrase (D11 §S-1)', () => {
  const body = FULL_BODY.replace('## Cost Circuit Breaker Overrides', '## Cost Overrides');
  const { dir, file } = writeTempBody(body);
  try {
    const r = run(file);
    assert.equal(r.status, 1, `Expected exit 1, got ${r.status}`);
    assert.match(r.stderr, /ERROR: PR body missing canonical template phrases/);
    assert.ok(
      r.stderr.includes('## Cost Circuit Breaker Overrides'),
      `stderr should name missing phrase '## Cost Circuit Breaker Overrides'\nActual stderr: ${r.stderr}`
    );
    assert.ok(
      !r.stderr.includes('## Scenario Walkthrough'),
      `stderr should NOT list '## Scenario Walkthrough' when it is present\nActual stderr: ${r.stderr}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 3b (FAIL): missing ## Requirement Ledger Completion → exit 1, stderr names missing phrase', () => {
  const body = FULL_BODY.replace('## Requirement Ledger Completion', '## Completion');
  const { dir, file } = writeTempBody(body);
  try {
    const r = run(file);
    assert.equal(r.status, 1, `Expected exit 1, got ${r.status}`);
    assert.match(r.stderr, /ERROR: PR body missing canonical template phrases/);
    assert.ok(
      r.stderr.includes('## Requirement Ledger Completion'),
      `stderr should name missing phrase '## Requirement Ledger Completion'\nActual stderr: ${r.stderr}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 3c (FAIL): empty Requirement Ledger Completion section → exit 1', () => {
  const body = FULL_BODY.replace(
    /## Requirement Ledger Completion[\s\S]*?## Test Evidence/,
    '## Requirement Ledger Completion\n\n## Test Evidence'
  );
  const { dir, file } = writeTempBody(body);
  try {
    const r = run(file);
    assert.equal(r.status, 1, `Expected exit 1, got ${r.status}`);
    assert.match(r.stderr, /Requirement Ledger Completion/);
    assert.match(r.stderr, /disposition counts or N\/A/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 3d (FAIL): Requirement Ledger Completion says tasks checked only → exit 1', () => {
  const body = FULL_BODY.replace(
    /## Requirement Ledger Completion[\s\S]*?## Test Evidence/,
    '## Requirement Ledger Completion\n- tasks checked\n\n## Test Evidence'
  );
  const { dir, file } = writeTempBody(body);
  try {
    const r = run(file);
    assert.equal(r.status, 1, `Expected exit 1, got ${r.status}`);
    assert.match(r.stderr, /Requirement Ledger Completion/);
    assert.match(r.stderr, /disposition counts or N\/A/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 3e (FAIL): Requirement Ledger Completion says all done only → exit 1', () => {
  const body = FULL_BODY.replace(
    /## Requirement Ledger Completion[\s\S]*?## Test Evidence/,
    '## Requirement Ledger Completion\n- all done\n\n## Test Evidence'
  );
  const { dir, file } = writeTempBody(body);
  try {
    const r = run(file);
    assert.equal(r.status, 1, `Expected exit 1, got ${r.status}`);
    assert.match(r.stderr, /Requirement Ledger Completion/);
    assert.match(r.stderr, /disposition counts or N\/A/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 3f (PASS): Requirement Ledger Completion N/A with reason → exit 0', () => {
  const body = FULL_BODY.replace(
    /## Requirement Ledger Completion[\s\S]*?## Test Evidence/,
    '## Requirement Ledger Completion\nN/A: chore A with no OpenSpec ledger\n\n## Test Evidence'
  );
  const { dir, file } = writeTempBody(body);
  try {
    const r = run(file);
    assert.equal(r.status, 0, `Expected exit 0, got ${r.status}\nstderr: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 4 (FAIL): empty body file → exit 2, stderr empty/unreadable', () => {
  const { dir, file } = writeTempBody('');
  try {
    const r = run(file);
    assert.equal(r.status, 2, `Expected exit 2, got ${r.status}`);
    assert.match(r.stderr, /ERROR: PR body input is empty or unreadable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 5 (FAIL): "Test Evidence" inside code block without H2 marker → exit 1 (H2 strictness)', () => {
  // The body has `Test Evidence` only inside a fenced code block, not as `## Test Evidence`
  const body = `
## OpenSpec
- change: ok

\`\`\`
Test Evidence: some output here
\`\`\`

## Security Review
- SQL injection：已檢查

## Change Context
- 改什麼：example landing
- 目的：example purpose

## Manual Test
- N/A: rule-only grep change; no human UI path

## Requirement Ledger Completion
- disposition counts: implemented 0, partial 0, deferred 0, rejected 0, moved-to-issue 0
- non-implemented rows: N/A

## Scenario Walkthrough
- Status: N/A (non-enforcement-carrier change)
- Evidence: N/A

## Conditional Fields
- 第三方套件：N/A
- **驗收證據**:
  - [ ] done
`.trim();
  const { dir, file } = writeTempBody(body);
  try {
    const r = run(file);
    assert.equal(r.status, 1, `Expected exit 1, got ${r.status}`);
    assert.ok(
      r.stderr.includes('## Test Evidence'),
      `stderr should report '## Test Evidence' as missing\nActual stderr: ${r.stderr}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 6 (PASS): source PR template carries Scenario Walkthrough contract', () => {
  const template = readFileSync(repoPath('.github/PULL_REQUEST_TEMPLATE.md'), 'utf8');

  assert.match(template, /## Scenario Walkthrough/);
  assert.match(template, /## Requirement Ledger Completion/);
  assert.match(template, /disposition counts/);
  assert.match(template, /skipped per user decision/);
  assert.match(template, /mechanical scenarios\.test\.mjs/);
  assert.match(template, PRECISE_CARRIER_GLOBS_RE);
  assert.doesNotMatch(template, BROAD_CARRIER_GLOBS_RE);
});

test('case 6a: source PR template carries all four exact Scenario Walkthrough states', () => {
  const template = readFileSync(repoPath('.github/PULL_REQUEST_TEMPLATE.md'), 'utf8');
  assertExactWalkthroughStates(template, '.github/PULL_REQUEST_TEMPLATE.md');
  assertStateRemovalFails(template, '.github/PULL_REQUEST_TEMPLATE.md');
});

test('case 7 (PASS): rule template and pre-pr command carry Scenario Walkthrough contract', () => {
  const rule = readFileSync(
    repoPath('.devpro/agent-rules/git-pr-template-and-merge.md'),
    'utf8'
  );
  const prePr = readFileSync(
    repoPath('.devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md'),
    'utf8'
  );

  assert.match(rule, /## Scenario Walkthrough/);
  assert.match(rule, /## Requirement Ledger Completion/);
  assert.match(rule, /disposition counts/);
  assert.match(rule, PRECISE_CARRIER_GLOBS_RE);
  assert.doesNotMatch(rule, BROAD_CARRIER_GLOBS_RE);
  assert.match(prePr, /OpenSpec.*Requirement Ledger Completion.*Test Evidence.*Scenario Walkthrough.*Security Review.*Conditional Fields/);
});

test('case 7a: governing PR rule carries all four exact Scenario Walkthrough states', () => {
  const rule = readFileSync(
    repoPath('.devpro/agent-rules/git-pr-template-and-merge.md'),
    'utf8'
  );
  assertExactWalkthroughStates(rule, '.devpro/agent-rules/git-pr-template-and-merge.md');
  assertStateRemovalFails(rule, '.devpro/agent-rules/git-pr-template-and-merge.md');
});

test('case 7b: devpro:pre-pr workflow carries all four exact Scenario Walkthrough states', () => {
  const prePr = readFileSync(
    repoPath('.devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md'),
    'utf8'
  );
  assertExactWalkthroughStates(prePr, '.devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md');
  assertStateRemovalFails(prePr, '.devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md');

  const contract = walkthroughContract(prePr, '.devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md');
  const mutated = prePr.replace(contract, `${contract}\n- 其他狀態 → 記錄 \`deferred\`\n`);
  assert.throws(
    () => assertExactWalkthroughStates(mutated, '.devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md'),
    /unsupported fifth Scenario Walkthrough state/
  );
});

test('fix-silent-gate-skip R6: devpro:pre-pr Part 1 lists agent-skills/**/references/*.md', () => {
  const skill = readFileSync(
    repoPath('.devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md'),
    'utf8'
  );
  const part1Start = skill.indexOf('#### Part 1: Trigger Conditions');
  const part2Start = skill.indexOf('#### Part 2:', part1Start);
  assert.ok(part1Start >= 0 && part2Start > part1Start, 'Part 1 block must exist');
  const part1 = skill.slice(part1Start, part2Start);
  assert.match(
    part1,
    /\.devpro\/agent-skills\/\*\*\/references\/\*\.md/,
    'Part 1 must list references/*.md trigger glob'
  );
});

test('fix-silent-gate-skip R7: non-empty overrides[] + body N/A → exit 1', () => {
  withChangeUsageStateDir(() => {
    const changeName = 'silent-gate-override-na';
    const cwd = makeTempDir('pr-body-disclosure-');
    mkdirSync(path.join(cwd, 'openspec', 'changes', changeName), { recursive: true });
    appendChangeUsageOverride({
      cwd,
      changeName,
      session_id: 's1',
      at: '2026-01-01T00:00:00.000Z',
      thresholds: ['output'],
      head_ref_oid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    const { dir, file } = writeTempBody(FULL_BODY);
    try {
      const r = spawnSync(
        'node',
        [SCRIPT, '--body-file', file, '--branch', `bugfix/${changeName}`, '--cwd', cwd],
        { encoding: 'utf8' }
      );
      assert.equal(r.status, 1, `expected exit 1; stderr=${r.stderr}`);
      assert.match(r.stderr, /Cost Circuit Breaker Overrides|override disclosure|N\/A/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

test('override disclosure mismatch prints the canonical lines the section should hold', () => {
  withChangeUsageStateDir(() => {
    const changeName = 'override-disclosure-expected-lines';
    const cwd = makeTempDir('pr-body-disclosure-');
    mkdirSync(path.join(cwd, 'openspec', 'changes', changeName), { recursive: true });
    const head = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    appendChangeUsageOverride({
      cwd,
      changeName,
      session_id: 's1',
      at: '2026-01-01T00:00:00.000Z',
      thresholds: ['output'],
      head_ref_oid: head,
    });
    const { dir, file } = writeTempBody(FULL_BODY);
    try {
      const r = spawnSync(
        'node',
        [SCRIPT, '--body-file', file, '--branch', `bugfix/${changeName}`, '--cwd', cwd],
        { encoding: 'utf8' }
      );
      assert.equal(r.status, 1, `expected exit 1; stderr=${r.stderr}`);
      assert.ok(
        r.stderr.includes(`- at=2026-01-01T00:00:00Z thresholds=output head_ref_oid=${head}`),
        `the failure must print the line the section should hold; stderr=${r.stderr}`
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// fix-second-review-loop-friction T6 (workflow-cost-controls ADDED "Round
// Override Consumption Is Recorded For Disclosure"): a `review_round`
// checkpoint override entry is disclosed through the SAME `## Cost Circuit
// Breaker Overrides` PR-body cross-check every other threshold uses — no
// special-cased threshold-name allowlist here, so `thresholds=review_round`
// round-trips through the identical `- at=... thresholds=... head_ref_oid=...`
// line format an `output`/`stalled_rounds` override already uses.
test('Scenario: Undisclosed review_round entry blocks the PR body check', () => {
  withChangeUsageStateDir(() => {
    const changeName = 'review-round-disclosure-na';
    const cwd = makeTempDir('pr-body-review-round-');
    mkdirSync(path.join(cwd, 'openspec', 'changes', changeName), { recursive: true });
    const at = '2026-01-01T00:00:00.000Z';
    const headRefOid = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    appendChangeUsageOverride({
      cwd,
      changeName,
      session_id: 's1',
      at,
      thresholds: ['review_round'],
      head_ref_oid: headRefOid,
    });
    const { dir: naDir, file: naFile } = writeTempBody(FULL_BODY);
    try {
      const naResult = spawnSync(
        'node',
        [SCRIPT, '--body-file', naFile, '--branch', `bugfix/${changeName}`, '--cwd', cwd],
        { encoding: 'utf8' }
      );
      assert.equal(naResult.status, 1, `N/A body must block; stderr=${naResult.stderr}`);
    } finally {
      rmSync(naDir, { recursive: true, force: true });
    }
    const matchingBody = FULL_BODY.replace(
      '## Cost Circuit Breaker Overrides\n- N/A',
      `## Cost Circuit Breaker Overrides\n- at=${at} thresholds=review_round head_ref_oid=${headRefOid}`
    );
    const { dir: matchDir, file: matchFile } = writeTempBody(matchingBody);
    try {
      const matchResult = spawnSync(
        'node',
        [SCRIPT, '--body-file', matchFile, '--branch', `bugfix/${changeName}`, '--cwd', cwd],
        { encoding: 'utf8' }
      );
      assert.equal(matchResult.status, 0, `matching disclosure line must pass; stderr=${matchResult.stderr}`);
    } finally {
      rmSync(matchDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// Same mechanism, framed as the D7 "reader reads a checkpoint" end-to-end
// property: once the read-side predicate holds for a branch (an active
// change folder here), that branch's disclosure check MUST NOT accept N/A
// once a review_round entry exists — independent of how the entry got there
// (a real render's disclosure write, or seeded directly as here).
test("Scenario: Consumed override is never disclosable as N/A when the reader reads a checkpoint", () => {
  withChangeUsageStateDir(() => {
    const changeName = 'review-round-reader-reads';
    const cwd = makeTempDir('pr-body-reader-reads-');
    mkdirSync(path.join(cwd, 'openspec', 'changes', changeName), { recursive: true });
    appendChangeUsageOverride({
      cwd,
      changeName,
      session_id: 's1',
      at: '2026-01-01T00:00:00.000Z',
      thresholds: ['review_round'],
      head_ref_oid: 'cccccccccccccccccccccccccccccccccccccccc',
    });
    const { dir, file } = writeTempBody(FULL_BODY);
    try {
      const r = spawnSync(
        'node',
        [SCRIPT, '--body-file', file, '--branch', `bugfix/${changeName}`, '--cwd', cwd],
        { encoding: 'utf8' }
      );
      assert.equal(r.status, 1, `expected block, not ok; stderr=${r.stderr}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// workflow-cost-controls ADDED "...", scenario "Archived change still
// records the entry": the read side (evaluateOverrideDisclosure via this
// script) accepts an archive-only change folder exactly like an active one
// (changeNameFolderExists's own archive-glob branch) — proving the
// disclosure check works uniformly regardless of which folder shape holds
// the review_round entry.
test('Scenario: Archived change still records the entry', () => {
  withChangeUsageStateDir(() => {
    const changeName = 'review-round-archive-only';
    const cwd = makeTempDir('pr-body-review-round-archive-');
    mkdirSync(path.join(cwd, 'openspec', 'changes', 'archive', `2026-01-01-${changeName}`), { recursive: true });
    appendChangeUsageOverride({
      cwd,
      changeName,
      session_id: 's1',
      at: '2026-01-01T00:00:00.000Z',
      thresholds: ['review_round'],
      head_ref_oid: 'dddddddddddddddddddddddddddddddddddddddd',
    });
    const { dir, file } = writeTempBody(FULL_BODY);
    try {
      const r = spawnSync(
        'node',
        [SCRIPT, '--body-file', file, '--branch', `bugfix/${changeName}`, '--cwd', cwd],
        { encoding: 'utf8' }
      );
      assert.equal(r.status, 1, `an archive-only change folder must still be read and blocked on N/A; stderr=${r.stderr}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

test('case 9: Release Target is warn-only — omission warns but does not block, presence is accepted', () => {
  const template = readFileSync(repoPath('.github/PULL_REQUEST_TEMPLATE.md'), 'utf8');
  assert.match(template, /Release Target: <YYYYMMDD>/, 'synced template must carry the Release Target field');
  assert.ok(!FULL_BODY.includes('Release Target'), 'fixture assumption: canonical body omits Release Target');

  // (a) omission → exit 0 AND an advisory warning that names Release Target
  const omitted = writeTempBody(FULL_BODY);
  try {
    const r = run(omitted.file);
    assert.equal(
      r.status,
      0,
      `Release Target omission MUST NOT block (warn-only), got ${r.status}\nstderr: ${r.stderr}`
    );
    assert.match(
      r.stderr,
      /ADVISORY:[\s\S]*Release Target/,
      `Release Target omission MUST warn (advisory), got stderr: ${r.stderr}`
    );
    assert.match(
      r.stderr,
      /advisory-only/,
      `advisory MUST state it does not fail the check\nstderr: ${r.stderr}`
    );
  } finally {
    rmSync(omitted.dir, { recursive: true, force: true });
  }

  // (b) presence → still exit 0 and the advisory disappears (proves the
  // injection is real, so this case cannot pass vacuously)
  const withField = FULL_BODY.replace(
    '## Conditional Fields\n',
    '## Conditional Fields\n- Release Target: <YYYYMMDD>\n'
  );
  assert.notEqual(withField, FULL_BODY, 'fixture MUST actually inject the Release Target line');
  assert.ok(
    withField.includes('- Release Target: <YYYYMMDD>'),
    'injected Release Target line MUST be present in the fixture body'
  );
  const present = writeTempBody(withField);
  try {
    const r = run(present.file);
    assert.equal(r.status, 0, `Release Target presence MUST pass, got ${r.status}\nstderr: ${r.stderr}`);
    assert.doesNotMatch(
      r.stderr,
      /ADVISORY:[\s\S]*Release Target/,
      `Release Target presence MUST NOT warn, got stderr: ${r.stderr}`
    );
  } finally {
    rmSync(present.dir, { recursive: true, force: true });
  }
});

// ── Evidence section and Change Context checks (strengthen-pre-pr-evidence-section-lint) ──
//
// The new checks run only for a PR that will be sent for a second opinion, so every case that expects a
// block uses a temporary git repo on a feature branch with a resolvable base and a remote-tracking ref equal
// to local HEAD (design D5 step 4). The four banned words are built by string joins so that neither this file
// nor the test names the PR text quotes carry them literally.

const TICK = String.fromCharCode(96);
const FENCE = TICK.repeat(3);
const BANNED = Object.freeze({
  one: ['TO', 'DO'].join(''),
  two: ['TB', 'D'].join(''),
  three: ['[fi', 'll'].join(''),
  four: ['place', 'holder'].join(''),
});
const SYNTHETIC_CHANGE = 'synthetic-evidence-lint';
const OPENSPEC_LINE = `- change: ${TICK}openspec/changes/${SYNTHETIC_CHANGE}/${TICK}`;
const COUNTS_LINE = '- disposition counts: implemented 1, partial 0, deferred 0, rejected 0, moved-to-issue 0';
const DEFAULT_CHANGE_CONTEXT = '- 改什麼：example landing\n- 目的：example purpose';
const DEFAULT_TEST_EVIDENCE = '- 結果：passed 5, failed 0';
const GIT_ENV = {
  ...process.env,
  // Git for Windows accepts its POSIX null path, not Node's device namespace.
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'tester',
  GIT_AUTHOR_EMAIL: 'tester.local',
  GIT_COMMITTER_NAME: 'tester',
  GIT_COMMITTER_EMAIL: 'tester.local',
};
const tempRoots = [];
after(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
});

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commitFiles(cwd, files, message) {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
    writeFileSync(path.join(cwd, name), content, 'utf8');
    git(cwd, ['add', '--', name]);
  }
  git(cwd, ['commit', '--allow-empty', '-q', '--no-verify', '-m', message]);
}

/**
 * Temporary repo: one base commit on main (origin/main points at it), then a branch with one change commit.
 * `remote` is 'head' (origin/<branch> equals HEAD), 'none' (no remote-tracking ref) or 'base' (a different commit).
 */
function makeRepo({ branch = 'feature/evidence-lint', branchFiles = { 'src/feature.txt': 'feature\n' }, baseFiles = {}, remote = 'head', originMain = true } = {}) {
  const cwd = makeTempDir('pr-body-evidence-repo-');
  tempRoots.push(cwd);
  git(cwd, ['init', '-q', '-b', 'main']);
  commitFiles(cwd, baseFiles, 'base');
  const base = git(cwd, ['rev-parse', 'HEAD']);
  if (originMain) git(cwd, ['update-ref', 'refs/remotes/origin/main', base]);
  git(cwd, ['checkout', '-q', '-b', branch]);
  commitFiles(cwd, branchFiles, 'change');
  const head = git(cwd, ['rev-parse', 'HEAD']);
  if (remote === 'head') git(cwd, ['update-ref', `refs/remotes/origin/${branch}`, head]);
  if (remote === 'base') git(cwd, ['update-ref', `refs/remotes/origin/${branch}`, base]);
  return { cwd, branch, base, head };
}

function evidenceBody({
  openspec = OPENSPEC_LINE,
  changeContext = DEFAULT_CHANGE_CONTEXT,
  ledger = COUNTS_LINE,
  testEvidence = DEFAULT_TEST_EVIDENCE,
  extraSections = [],
} = {}) {
  // `extraSections` are raw lines placed after Test Evidence (an old PR body may still carry a retired section).
  return [
    '## OpenSpec', openspec, '',
    '## Change Context', changeContext, '',
    '## Manual Test', '- N/A: rule-only change; no human UI path', '',
    '## Requirement Ledger Completion', ledger, '',
    '## Test Evidence', testEvidence, '',
    ...extraSections,
    '## Scenario Walkthrough', '- Status: N/A (non-enforcement-carrier change)', '',
    '## Cost Circuit Breaker Overrides', '- N/A', '',
    '## Conditional Fields', '- 驗收證據：見 Test Evidence',
  ].join('\n');
}

// The Requirement Ledger text that makes OpenSpec + Ledger joined with one blank line exactly `target` bytes.
function ledgerForJoinedBytes(target) {
  const prefix = `${COUNTS_LINE}\n- note: `;
  const fill = target - Buffer.byteLength(OPENSPEC_LINE, 'utf8') - 2 - Buffer.byteLength(prefix, 'utf8');
  return prefix + 'y'.repeat(fill);
}

function runLint(repo, body, { args = [], branch = repo.branch, omitBranch = false } = {}) {
  const { dir, file } = writeTempBody(body);
  try {
    return spawnSync(
      'node',
      [SCRIPT, '--body-file', file, '--cwd', repo.cwd, ...(omitBranch ? [] : ['--branch', branch]), ...args],
      { encoding: 'utf8' },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CHECKED_LINE = /evidence-section checks: checked \(second review required; branch=feature\/evidence-lint; base=origin\/main; changed files=1\)/;

function assertBlockedByEvidenceChecks(r, label) {
  assert.equal(r.status, 1, `${label}: expected exit 1, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stderr, /PR body would be rejected by the second-review handoff builder/, label);
  assert.doesNotMatch(r.stderr, /missing canonical template phrases/, `${label}: the existing checks must have passed first`);
}

function assertPassedChecked(r, label) {
  assert.equal(r.status, 0, `${label}: expected exit 0, got ${r.status}\nstderr: ${r.stderr}`);
  assert.match(r.stdout, CHECKED_LINE, label);
}

function assertSkipped(r, reasonPattern, label) {
  assert.equal(r.status, 0, `${label}: expected exit 0, got ${r.status}\nstderr: ${r.stderr}`);
  assert.match(r.stdout, /OK: PR body template canonical phrases present/, label);
  assert.match(r.stdout, reasonPattern, label);
  assert.doesNotMatch(r.stderr, /rejected by the second-review handoff builder/, label);
}

let sharedRequiredRepo;
function requiredRepo() {
  sharedRequiredRepo ??= makeRepo();
  return sharedRequiredRepo;
}

test('evidence checks: a clean body on a non-exempt branch passes and states what was checked', () => {
  assertPassedChecked(runLint(requiredRepo(), evidenceBody()), 'clean body');
});

test('Scenario: Evidence section over the byte limit blocks before PR creation', () => {
  const repo = requiredRepo();
  assertPassedChecked(runLint(repo, evidenceBody({ testEvidence: 'x'.repeat(PR_EVIDENCE_SECTION_MAX_BYTES) })), 'Test Evidence at the limit');
  const over = runLint(repo, evidenceBody({ testEvidence: 'x'.repeat(PR_EVIDENCE_SECTION_MAX_BYTES + 1) }));
  assertBlockedByEvidenceChecks(over, 'Test Evidence one byte over');
  assert.ok(over.stderr.includes(`## Test Evidence: ${PR_EVIDENCE_SECTION_MAX_BYTES + 1} UTF-8 bytes; limit ${PR_EVIDENCE_SECTION_MAX_BYTES}`), over.stderr);
  assert.ok(over.stderr.includes('## Supplementary Evidence'), 'the fix names the separate section');
  assert.match(over.stderr, /Checked because: second review required \(branch=feature\/evidence-lint; base=origin\/main; changed files=1\)/);
  assert.match(over.stderr, /Reference: .*git-pr-template-and-merge\.md/);

  // OpenSpec and Requirement Ledger Completion are measured trimmed and joined with one blank line.
  const atLimit = ledgerForJoinedBytes(PR_EVIDENCE_SECTION_MAX_BYTES);
  assert.ok(Buffer.byteLength(atLimit, 'utf8') < PR_EVIDENCE_SECTION_MAX_BYTES, 'each section alone is under the limit');
  assertPassedChecked(runLint(repo, evidenceBody({ ledger: atLimit })), 'joined validation sections at the limit');
  const joinedOver = runLint(repo, evidenceBody({ ledger: ledgerForJoinedBytes(PR_EVIDENCE_SECTION_MAX_BYTES + 1) }));
  assertBlockedByEvidenceChecks(joinedOver, 'joined validation sections one byte over');
  assert.ok(
    joinedOver.stderr.includes(`## OpenSpec + ## Requirement Ledger Completion (joined with one blank line): ${PR_EVIDENCE_SECTION_MAX_BYTES + 1} UTF-8 bytes; limit ${PR_EVIDENCE_SECTION_MAX_BYTES}`),
    joinedOver.stderr,
  );
});

test('evidence checks: the byte limit counts UTF-8 bytes, so three-byte characters reach it sooner', () => {
  const repo = requiredRepo();
  const fit = '漢'.repeat(Math.floor(PR_EVIDENCE_SECTION_MAX_BYTES / 3));
  assert.ok(Buffer.byteLength(fit, 'utf8') <= PR_EVIDENCE_SECTION_MAX_BYTES);
  assertPassedChecked(runLint(repo, evidenceBody({ testEvidence: fit })), 'CJK text that fits');
  const over = runLint(repo, evidenceBody({ testEvidence: `${fit}漢` }));
  assertBlockedByEvidenceChecks(over, 'CJK text one character over');
  assert.ok(over.stderr.includes(`## Test Evidence: ${Buffer.byteLength(`${fit}漢`, 'utf8')} UTF-8 bytes`), over.stderr);
});

test('Scenario: Change Context over the scope summary limit blocks before PR creation', () => {
  const repo = requiredRepo();
  assertPassedChecked(runLint(repo, evidenceBody({ changeContext: 'a'.repeat(PR_CHANGE_CONTEXT_MAX_BYTES) })), 'Change Context at the limit');
  const over = runLint(repo, evidenceBody({ changeContext: 'a'.repeat(PR_CHANGE_CONTEXT_MAX_BYTES + 1) }));
  assertBlockedByEvidenceChecks(over, 'Change Context one byte over');
  assert.ok(
    over.stderr.includes(`## Change Context (normalized scope_summary): ${PR_CHANGE_CONTEXT_MAX_BYTES + 1} UTF-8 bytes; limit ${PR_CHANGE_CONTEXT_MAX_BYTES}`),
    over.stderr,
  );
  // The limit applies after normalization: list markers and newlines shrink the raw section below it.
  const half = 'a'.repeat(Math.floor(PR_CHANGE_CONTEXT_MAX_BYTES / 2) - 1);
  const rawContext = `- ${half}\n- ${half}`;
  assert.ok(Buffer.byteLength(rawContext, 'utf8') > PR_CHANGE_CONTEXT_MAX_BYTES);
  assertPassedChecked(runLint(repo, evidenceBody({ changeContext: rawContext })), 'raw section over the limit but normalized under it');
  // A Change Context that is long only because the evidence sections are not is judged on its own.
  assertPassedChecked(runLint(repo, evidenceBody({ testEvidence: 'x'.repeat(PR_EVIDENCE_SECTION_MAX_BYTES) })), 'evidence at its own limit');
});

test('Scenario: Unfilled template text blocks while command templates in code pass', () => {
  const repo = requiredRepo();
  // Each banned word blocks and the stderr lists the matched text, in either evidence field.
  for (const word of Object.values(BANNED)) {
    const inTest = runLint(repo, evidenceBody({ testEvidence: `- 結果：${word} remains` }));
    assertBlockedByEvidenceChecks(inTest, `banned word ${word.length} chars in Test Evidence`);
    assert.ok(inTest.stderr.includes(`## Test Evidence: unfilled template text "${word}"`), inTest.stderr);
    const inLedger = runLint(repo, evidenceBody({ ledger: `${COUNTS_LINE}\n- note: ${word} remains` }));
    assertBlockedByEvidenceChecks(inLedger, `banned word ${word.length} chars in the ledger`);
    assert.ok(inLedger.stderr.includes('## OpenSpec + ## Requirement Ledger Completion: unfilled template text'), inLedger.stderr);
    assert.ok(inLedger.stderr.includes(`"${word}"`), inLedger.stderr);
  }
  // An unmodified template field outside code is listed verbatim.
  const field = '<驗收條件 1 + 具體證據>';
  const outside = runLint(repo, evidenceBody({ testEvidence: `- ${field}` }));
  assertBlockedByEvidenceChecks(outside, 'template field outside code');
  assert.ok(outside.stderr.includes(JSON.stringify(field)), outside.stderr);
  assert.match(outside.stderr, /replace it with the real content/);
  // Command templates written as one ASCII token inside inline code pass.
  const commandTemplates = [
    `${TICK}<X.Y.Z>${TICK}`,
    `${TICK}--changed <tested-sha>${TICK}`,
    `${TICK}openspec/changes/archive/<name>${TICK}`,
    `${TICK}hooks-git/<hook>.local${TICK}`,
    `\n${FENCE}\nnode check --changed <sha>\n${FENCE}`,
  ];
  for (const template of commandTemplates) {
    assertPassedChecked(runLint(repo, evidenceBody({ testEvidence: `- 指令：${template}` })), `command template ${template.length} chars`);
  }
  // Spaced or CJK fields are residue even inside code, and so is the known false positive for a spaced field.
  for (const residue of [`${TICK}<passed X, failed 0, skipped Y>${TICK}`, `${TICK}<各 gate 輸出的範圍>${TICK}`, `${TICK}<observed OID>${TICK}`, `implemented <n> ${TICK}keep${TICK}`]) {
    assertBlockedByEvidenceChecks(runLint(repo, evidenceBody({ testEvidence: `- ${residue}` })), `residue ${residue.length} chars`);
  }
  // A ledger field outside code is residue even when the OpenSpec section ends inside an unclosed fence.
  const crossSection = evidenceBody({
    openspec: `${OPENSPEC_LINE}\n${FENCE}\nnode check --changed`,
    ledger: `${COUNTS_LINE}\n- follow-up: implemented <n>`,
  });
  assertBlockedByEvidenceChecks(runLint(repo, crossSection), 'unclosed fence does not carry code state into the next section');
  // The Change Context rule is not relaxed: even a single identifier in code still blocks.
  const context = runLint(repo, evidenceBody({ changeContext: `- 目的：explain ${TICK}<name>${TICK} in code` }));
  assertBlockedByEvidenceChecks(context, 'identifier in code inside the Change Context');
  assert.ok(context.stderr.includes('## Change Context: unfilled template text "<name>"'), context.stderr);
  // The Change Context rule has no bracketed fill marker, so that wording alone is accepted there.
  assertPassedChecked(runLint(repo, evidenceBody({ changeContext: `- 目的：mention ${BANNED.three} later` })), 'bracketed fill marker in the Change Context');
});

test('evidence checks: findings of all three kinds are listed in one message', () => {
  const r = runLint(requiredRepo(), evidenceBody({
    testEvidence: `x ${BANNED.two} x`.padEnd(PR_EVIDENCE_SECTION_MAX_BYTES + 5, 'y'),
    changeContext: 'a'.repeat(PR_CHANGE_CONTEXT_MAX_BYTES + 1),
  }));
  assertBlockedByEvidenceChecks(r, 'combined findings');
  assert.match(r.stderr, /## Test Evidence: \d+ UTF-8 bytes; limit \d+/);
  assert.match(r.stderr, /## Test Evidence: unfilled template text/);
  assert.match(r.stderr, /## Change Context \(normalized scope_summary\): \d+ UTF-8 bytes/);
  assert.match(r.stderr, /Fix:/);
});

test('evidence checks: empty or control-character findings of the builder are not blocked by the lint', () => {
  const repo = requiredRepo();
  assertPassedChecked(runLint(repo, evidenceBody({ testEvidence: '' })), 'empty Test Evidence is outside the three blocked kinds');
  const control = runLint(repo, evidenceBody({ changeContext: `Clarify${String.fromCharCode(8)}behavior` }));
  assertPassedChecked(control, 'control characters in the Change Context are outside the three blocked kinds');
});

test('Scenario: A chore branch that only edits ANOTHER change\'s existing proposal stays chore A (#3333)', () => {
  const overLimit = evidenceBody({ testEvidence: 'x'.repeat(PR_EVIDENCE_SECTION_MAX_BYTES + 1) });
  const foreign = 'openspec/changes/other-change/proposal.md';
  const baseFiles = { [foreign]: 'release: 2026-09-01\n' };

  // Control for the fixture: the exemption below is only meaningful if the edit really is a modification.
  const edited = makeRepo({ branch: 'chore/fix-release-date', baseFiles, branchFiles: { [foreign]: 'release: 2026-10-01\n' } });
  assert.match(git(edited.cwd, ['diff', '--name-status', 'origin/main...HEAD']), /^M\topenspec\/changes\/other-change\/proposal\.md$/m);
  assertSkipped(runLint(edited, overLimit), /evidence-section checks: skipped \(exempt: diff-shape: chore\/ 前綴車道/, 'in-place edit of another change\'s proposal');

  // The branch's OWN change: the same edit is proposal evidence, so the evidence checks apply.
  const own = makeRepo({
    branch: 'chore/other-change',
    baseFiles,
    branchFiles: { [foreign]: 'release: 2026-10-01\n' },
  });
  assertBlockedByEvidenceChecks(runLint(own, overLimit), 'edit of the branch\'s own change proposal');

  // A proposal that is ADDED (new, not an edit) is design work.
  const added = makeRepo({ branch: 'chore/adds-proposal', branchFiles: { 'openspec/changes/brand-new/proposal.md': 'proposal\n' } });
  assertBlockedByEvidenceChecks(runLint(added, overLimit), 'a newly added proposal');

  // A proposal that is DELETED is not an in-place edit either.
  const deleted = makeRepo({ branch: 'chore/drops-proposal', baseFiles, branchFiles: {} });
  git(deleted.cwd, ['rm', '-q', foreign]);
  git(deleted.cwd, ['commit', '-q', '--no-verify', '-m', 'drop proposal']);
  git(deleted.cwd, ['update-ref', 'refs/remotes/origin/chore/drops-proposal', git(deleted.cwd, ['rev-parse', 'HEAD'])]);
  assertBlockedByEvidenceChecks(runLint(deleted, overLimit), 'a deleted proposal');
});

test('Scenario: Exempt or undeterminable PRs are not blocked by the evidence checks', () => {
  const overLimit = evidenceBody({ testEvidence: 'x'.repeat(PR_EVIDENCE_SECTION_MAX_BYTES + 1) });

  // Exempt: a chore branch whose local diff has no proposal file (chore A), and the version bump branch.
  const choreA = makeRepo({ branch: 'chore/tidy-notes' });
  assertSkipped(runLint(choreA, overLimit), /evidence-section checks: skipped \(exempt: diff-shape: chore\/ 前綴車道/, 'chore A branch');
  const bump = makeRepo({ branch: 'chore/bump-v1.2.3' });
  assertSkipped(runLint(bump, overLimit), /evidence-section checks: skipped \(exempt: branch-pattern: chore\/bump-v/, 'version bump branch');

  // The same chore branch is required once its diff carries a proposal file, so the exemption is real.
  const choreWithProposal = makeRepo({ branch: 'chore/with-proposal', branchFiles: { 'openspec/changes/x/proposal.md': 'proposal\n' } });
  assertBlockedByEvidenceChecks(runLint(choreWithProposal, overLimit), 'chore branch that carries a proposal');

  const repo = requiredRepo();
  assertBlockedByEvidenceChecks(runLint(repo, overLimit), 'control: the same body blocks on the plain feature branch');

  // --pr-head: a different branch or a fork form is not described by the local diff; the same name still blocks.
  assertSkipped(runLint(repo, overLimit, { args: ['--pr-head', 'feature/other'] }), /not verified: --pr-head feature\/other differs from local branch feature\/evidence-lint/, 'different head');
  assertSkipped(runLint(repo, overLimit, { args: ['--pr-head', `fork-owner:${repo.branch}`] }), /not verified: --pr-head fork-owner:feature\/evidence-lint differs/, 'fork form head');
  assertBlockedByEvidenceChecks(runLint(repo, overLimit, { args: ['--pr-head', repo.branch] }), 'head equal to the local branch');

  // --pr-target-unresolved and detached HEAD.
  assertSkipped(runLint(repo, overLimit, { args: ['--pr-target-unresolved'] }), /not verified: .*not a literal value/, 'unresolved target');
  const detached = makeRepo({ branch: 'feature/detached-case' });
  git(detached.cwd, ['checkout', '-q', '--detach']);
  assertSkipped(runLint(detached, overLimit, { omitBranch: true }), /not verified: .*detached HEAD/, 'detached HEAD without --branch');

  // The base cannot be resolved: no origin/main, or an unknown --pr-base.
  const noBase = makeRepo({ branch: 'feature/no-base', originMain: false });
  assertSkipped(runLint(noBase, overLimit), /not verified: base unresolved \(tried /, 'no canonical base ref');
  assertSkipped(runLint(repo, overLimit, { args: ['--pr-base', 'no-such-base'] }), /not verified: base unresolved \(tried origin\/no-such-base, no-such-base\)/, 'unknown --pr-base');
  // A known --pr-base is used: origin/main first, then the local branch of that name.
  assertBlockedByEvidenceChecks(runLint(repo, overLimit, { args: ['--pr-base', 'main'] }), 'literal base that resolves');
  const localOnlyBase = makeRepo({ branch: 'feature/local-base', originMain: false });
  const localBase = runLint(localOnlyBase, overLimit, { args: ['--pr-base', 'main'] });
  assertBlockedByEvidenceChecks(localBase, 'base found as a local branch');
  assert.match(localBase.stderr, /base=main; changed files=1/);
});

test('Scenario: Remote branch not proven to match local HEAD is not blocked', () => {
  const overLimit = evidenceBody({ testEvidence: 'x'.repeat(PR_EVIDENCE_SECTION_MAX_BYTES + 1) });

  // Three states of refs/remotes/origin/<branch> on a feature branch.
  const missing = makeRepo({ branch: 'feature/no-remote-ref', remote: 'none' });
  assertSkipped(runLint(missing, overLimit), /not verified: no remote-tracking ref origin\/feature\/no-remote-ref \(origin 無法確認\)/, 'origin cannot be confirmed (no origin remote)');
  const differs = makeRepo({ branch: 'feature/stale-remote-ref', remote: 'base' });
  assertSkipped(runLint(differs, overLimit), /not verified: origin\/feature\/stale-remote-ref differs from local HEAD/, 'remote-tracking ref at another commit');
  const same = makeRepo({ branch: 'feature/synced-remote-ref', remote: 'head' });
  const blocked = runLint(same, overLimit);
  assert.equal(blocked.status, 1, `ref equal to local HEAD must block\nstderr: ${blocked.stderr}`);
  assert.ok(blocked.stderr.includes(`## Test Evidence: ${PR_EVIDENCE_SECTION_MAX_BYTES + 1} UTF-8 bytes; limit ${PR_EVIDENCE_SECTION_MAX_BYTES}`), blocked.stderr);

  // Only a ref whose whole name matches counts: a deeper ref under the same prefix is not this branch.
  const prefixOnly = makeRepo({ branch: 'feature/prefix-case', remote: 'none' });
  git(prefixOnly.cwd, ['update-ref', 'refs/remotes/origin/feature/prefix-case/sub', prefixOnly.head]);
  assertSkipped(runLint(prefixOnly, overLimit), /not verified: no remote-tracking ref origin\/feature\/prefix-case/, 'prefix-only remote-tracking ref');

  // Same-name branches that diverge, in both directions (chore branch, proposal file on one side only).
  // Direction 1: the proposal exists only on the remote side. The local diff alone would read exempt (chore A).
  const remoteOnly = makeRepo({ branch: 'chore/remote-only-proposal', remote: 'none' });
  git(remoteOnly.cwd, ['checkout', '-q', '-b', 'remote-side', remoteOnly.base]);
  commitFiles(remoteOnly.cwd, { 'openspec/changes/y/proposal.md': 'proposal\n' }, 'remote proposal');
  git(remoteOnly.cwd, ['update-ref', `refs/remotes/origin/${remoteOnly.branch}`, git(remoteOnly.cwd, ['rev-parse', 'HEAD'])]);
  git(remoteOnly.cwd, ['checkout', '-q', remoteOnly.branch]);
  assertSkipped(runLint(remoteOnly, overLimit), /not verified: origin\/chore\/remote-only-proposal differs from local HEAD/, 'proposal only on the remote side');
  // Direction 2: the proposal exists only on the local side and there is no remote-tracking ref.
  const localOnly = makeRepo({ branch: 'chore/local-only-proposal', remote: 'none', branchFiles: { 'openspec/changes/z/proposal.md': 'proposal\n' } });
  assertSkipped(runLint(localOnly, overLimit), /not verified: no remote-tracking ref origin\/chore\/local-only-proposal/, 'proposal only on the local side');

  // Git failures are not blocking: no repo at all, and a repo whose HEAD cannot be read.
  const notARepo = { cwd: makeTempDir('pr-body-evidence-norepo-'), branch: 'feature/not-a-repo' };
  tempRoots.push(notARepo.cwd);
  assertSkipped(runLint(notARepo, overLimit), /evidence-section checks: skipped \(not verified: /, 'cwd that is not a git repo');
  const orphan = makeRepo({ branch: 'feature/orphan-case' });
  git(orphan.cwd, ['checkout', '-q', '--orphan', 'feature/orphan-case-unborn']);
  assertSkipped(runLint({ cwd: orphan.cwd, branch: 'feature/orphan-case' }, overLimit), /evidence-section checks: skipped \(not verified: /, 'repo whose HEAD cannot be read');
});

// ── T12: no remote-tracking ref, so the lint asks origin whether the branch exists (decisions D3 R14) ──
// origin is a local bare repo (no network). Only an explicit "no such ref" answer (ls-remote exit 2) proves a
// first PR; every other answer keeps the fail-open unknown.

const ORIGIN_ABSENT_NOTE = 'origin 沒有同名分支（首次 PR）';
const OVER_LIMIT_BODY = evidenceBody({ testEvidence: 'x'.repeat(PR_EVIDENCE_SECTION_MAX_BYTES + 1) });

/** Adds a local bare repo as `origin`; `pushSha` (when given) is pushed as the same-named branch, without leaving a remote-tracking ref. */
function addBareOrigin(repo, { pushSha = null } = {}) {
  const bare = makeTempDir('pr-body-evidence-origin-');
  tempRoots.push(bare);
  git(bare, ['init', '-q', '--bare']);
  git(repo.cwd, ['remote', 'add', 'origin', bare]);
  if (pushSha) {
    git(repo.cwd, ['push', '-q', 'origin', `${pushSha}:refs/heads/${repo.branch}`]);
    git(repo.cwd, ['update-ref', '-d', `refs/remotes/origin/${repo.branch}`]);
  }
  return bare;
}

test('origin ask: origin without the branch and no remote-tracking ref is a first PR judged on local HEAD', () => {
  // Over the limit on a feature branch: blocked, and the reason names why the check ran.
  const feature = makeRepo({ branch: 'feature/first-pr-over', remote: 'none' });
  addBareOrigin(feature);
  const blocked = runLint(feature, OVER_LIMIT_BODY);
  assertBlockedByEvidenceChecks(blocked, 'first PR over the limit');
  assert.ok(blocked.stderr.includes(`## Test Evidence: ${PR_EVIDENCE_SECTION_MAX_BYTES + 1} UTF-8 bytes`), blocked.stderr);
  assert.ok(blocked.stderr.includes(`Checked because: second review required (branch=feature/first-pr-over; base=origin/main; changed files=1; ${ORIGIN_ABSENT_NOTE})`), blocked.stderr);

  // Under the limit: checked, and stdout says origin has no such branch.
  const clean = runLint(feature, evidenceBody());
  assert.equal(clean.status, 0, clean.stderr);
  assert.ok(
    clean.stdout.includes(`evidence-section checks: checked (second review required; branch=feature/first-pr-over; base=origin/main; changed files=1; ${ORIGIN_ABSENT_NOTE})`),
    clean.stdout,
  );

  // A chore branch whose local diff has no proposal stays exempt.
  const chore = makeRepo({ branch: 'chore/first-pr-exempt', remote: 'none' });
  addBareOrigin(chore);
  assertSkipped(runLint(chore, OVER_LIMIT_BODY), /evidence-section checks: skipped \(exempt: diff-shape: chore\/ 前綴車道/, 'first PR on an exempt chore branch');

  // The same chore branch with a proposal in the local diff is required.
  const choreProposal = makeRepo({ branch: 'chore/first-pr-proposal', remote: 'none', branchFiles: { 'openspec/changes/p/proposal.md': 'proposal\n' } });
  addBareOrigin(choreProposal);
  assertBlockedByEvidenceChecks(runLint(choreProposal, OVER_LIMIT_BODY), 'first PR on a chore branch that carries a proposal');
});

test('origin ask: origin that has a same-named branch is not blocked, in both proposal directions', () => {
  // Direction 1: the proposal exists only on the origin side; the local diff alone would read exempt.
  const remoteOnly = makeRepo({ branch: 'chore/origin-has-proposal', remote: 'none' });
  git(remoteOnly.cwd, ['checkout', '-q', '-b', 'origin-side', remoteOnly.base]);
  commitFiles(remoteOnly.cwd, { 'openspec/changes/y/proposal.md': 'proposal\n' }, 'origin proposal');
  const originSideSha = git(remoteOnly.cwd, ['rev-parse', 'HEAD']);
  git(remoteOnly.cwd, ['checkout', '-q', remoteOnly.branch]);
  addBareOrigin(remoteOnly, { pushSha: originSideSha });
  assertSkipped(runLint(remoteOnly, OVER_LIMIT_BODY), /not verified: no remote-tracking ref origin\/chore\/origin-has-proposal \(origin 回答：有同名分支\)/, 'proposal only on the origin side');

  // Direction 2: the proposal exists only on the local side; origin has the branch at the base commit.
  const localOnly = makeRepo({ branch: 'chore/local-has-proposal', remote: 'none', branchFiles: { 'openspec/changes/z/proposal.md': 'proposal\n' } });
  addBareOrigin(localOnly, { pushSha: localOnly.base });
  assertSkipped(runLint(localOnly, OVER_LIMIT_BODY), /not verified: no remote-tracking ref origin\/chore\/local-has-proposal \(origin 回答：有同名分支\)/, 'proposal only on the local side');

  // Even at the same commit as local HEAD the missing remote-tracking ref is not proof: origin answered, the lint does not block.
  const sameSha = makeRepo({ branch: 'feature/origin-has-same-sha', remote: 'none' });
  addBareOrigin(sameSha, { pushSha: sameSha.head });
  assertSkipped(runLint(sameSha, OVER_LIMIT_BODY), /\(origin 回答：有同名分支\)/, 'origin has the same commit but no tracking ref');
});

test('origin ask: no origin remote or an unreachable origin address is unknown and not blocked', () => {
  const noOrigin = makeRepo({ branch: 'feature/ask-no-origin', remote: 'none' });
  assertSkipped(runLint(noOrigin, OVER_LIMIT_BODY), /not verified: no remote-tracking ref origin\/feature\/ask-no-origin \(origin 無法確認\)/, 'no origin remote');

  const badPath = makeRepo({ branch: 'feature/ask-bad-origin', remote: 'none' });
  git(badPath.cwd, ['remote', 'add', 'origin', path.join(badPath.cwd, 'no-such-origin-dir')]);
  assertSkipped(runLint(badPath, OVER_LIMIT_BODY), /not verified: no remote-tracking ref origin\/feature\/ask-bad-origin \(origin 無法確認\)/, 'origin address that does not exist');
});

test('origin ask: an existing remote-tracking ref is judged without contacting origin', () => {
  // Ref equal to HEAD with an unreachable origin address: checked as usual, so nothing tried to connect.
  const same = makeRepo({ branch: 'feature/ask-ref-same', remote: 'head' });
  git(same.cwd, ['remote', 'add', 'origin', path.join(same.cwd, 'no-such-origin-dir')]);
  const blocked = runLint(same, OVER_LIMIT_BODY);
  assertBlockedByEvidenceChecks(blocked, 'ref equal to HEAD, origin address does not exist');
  assert.doesNotMatch(blocked.stderr, /origin 沒有同名分支|origin 回答|origin 無法確認/);
  const clean = runLint(same, evidenceBody());
  assert.equal(clean.status, 0, clean.stderr);
  assert.doesNotMatch(clean.stdout, /首次 PR/);

  // Ref at another commit while origin truly has no such branch: still "differs", never "first PR".
  const differs = makeRepo({ branch: 'feature/ask-ref-differs', remote: 'base' });
  addBareOrigin(differs);
  const skipped = runLint(differs, OVER_LIMIT_BODY);
  assertSkipped(skipped, /not verified: origin\/feature\/ask-ref-differs differs from local HEAD/, 'ref at another commit with an origin that lacks the branch');
  assert.doesNotMatch(skipped.stdout, /首次 PR|origin 回答|origin 無法確認/);
});

// Function-level fail-open: a dynamic import cannot be made to fail through the CLI, so the evaluator takes an injected importModule.
async function loadLint() {
  return import(pathToFileURL(SCRIPT).href);
}
const realImport = (specifier) => import(new URL(specifier, pathToFileURL(SCRIPT)).href);

test('Scenario: Exempt or undeterminable PRs are not blocked by the evidence checks (internal failures skip with exit code 0)', async () => {
  const { runEvidenceSectionChecks } = await loadLint();
  const repo = requiredRepo();
  const args = { body: evidenceBody({ testEvidence: 'x'.repeat(PR_EVIDENCE_SECTION_MAX_BYTES + 1) }), branch: repo.branch, cwd: repo.cwd };

  // Control: the real modules block this body.
  const blocked = await runEvidenceSectionChecks({ ...args, importModule: realImport });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.exitCode, 1);
  assert.match(blocked.stderr, /## Test Evidence/);

  const failures = {
    'the shared rules module fails to load': (specifier) => (specifier.includes('pr-body-evidence-rules') ? Promise.reject(new Error('rules load failed')) : realImport(specifier)),
    'the gate module fails to load': (specifier) => (specifier.includes('pre-tool-gate') ? Promise.reject(new Error('gate load failed')) : realImport(specifier)),
    'every import fails': () => Promise.reject(new Error('all imports failed')),
    'the exemption check throws': async (specifier) => (specifier.includes('pre-tool-gate')
      ? { isCrossModelExempt() { throw new Error('exemption exploded'); }, crossModelExemptionReason() { return null; } }
      : realImport(specifier)),
    'a finding function throws': async (specifier) => (specifier.includes('pr-body-evidence-rules')
      ? { ...(await realImport(specifier)), evidenceFieldFindings() { throw new Error('finding exploded'); } }
      : realImport(specifier)),
    'an import throws synchronously': (specifier) => { if (specifier.includes('pre-tool-gate')) throw new Error('sync import failure'); return realImport(specifier); },
  };
  for (const [label, importModule] of Object.entries(failures)) {
    const result = await runEvidenceSectionChecks({ ...args, importModule });
    assert.equal(result.status, 'skipped', label);
    assert.equal(result.exitCode, 0, label);
    assert.equal(result.stderr, '', label);
    assert.match(result.stdout, /evidence-section checks: skipped \(internal error: .+\)/, label);
  }

  // The exemption check can also be stubbed to a verdict: exempt skips, required checks.
  const stub = (exempt, reason) => async (specifier) => (specifier.includes('pre-tool-gate')
    ? { isCrossModelExempt: () => exempt, crossModelExemptionReason: () => reason }
    : realImport(specifier));
  const exempt = await runEvidenceSectionChecks({ ...args, importModule: stub(true, 'stubbed label') });
  assert.equal(exempt.status, 'skipped');
  assert.equal(exempt.exitCode, 0);
  assert.match(exempt.stdout, /skipped \(exempt: stubbed label\)/);
  const required = await runEvidenceSectionChecks({ ...args, importModule: stub(false, null) });
  assert.equal(required.status, 'blocked');
  assert.equal(required.exitCode, 1);

  // A clean body reports checked with exit code 0.
  const clean = await runEvidenceSectionChecks({ ...args, body: evidenceBody(), importModule: realImport });
  assert.equal(clean.status, 'checked');
  assert.equal(clean.exitCode, 0);
  assert.match(clean.stdout, CHECKED_LINE);
});

test('evidence checks: the exemption check receives the branch, a real changed-file list and the cwd, never an empty stand-in', async () => {
  const { runEvidenceSectionChecks } = await loadLint();
  const repo = requiredRepo();
  const calls = [];
  const importModule = async (specifier) => (specifier.includes('pre-tool-gate')
    ? { isCrossModelExempt: (...a) => { calls.push(a); return false; }, crossModelExemptionReason: () => null }
    : realImport(specifier));
  await runEvidenceSectionChecks({ body: evidenceBody(), branch: repo.branch, cwd: repo.cwd, importModule });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 3), [repo.branch, ['src/feature.txt'], repo.cwd]);
  // #3333: the fourth argument is the per-file status map, so a chore PR's exemption can tell an in-place edit
  // of another change's proposal from an added one.
  assert.ok(calls[0][3] instanceof Map);
  assert.deepEqual([...calls[0][3]], [['src/feature.txt', 'added']]);
  // The sixth argument is the base the diff was taken against, without `origin/`: with no --base it is the
  // default branch the diff used, so a zero-diff ancestry repair into main is still recognized.
  assert.equal(calls[0][5], 'main');
  calls.length = 0;
  await runEvidenceSectionChecks({ body: evidenceBody(), branch: repo.branch, cwd: repo.cwd, prBase: 'main', importModule });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][5], 'main', 'an explicit --base names the same base');

  // An unknown diff is never passed on as an empty list: the exemption check is not called at all.
  calls.length = 0;
  const unknown = await runEvidenceSectionChecks({ body: evidenceBody(), branch: repo.branch, cwd: repo.cwd, prBase: 'no-such-base', importModule });
  assert.equal(calls.length, 0);
  assert.equal(unknown.status, 'skipped');
  assert.match(unknown.stdout, /not verified: base unresolved/);
});

test('Scenario: Bodies rejected by the existing checks keep their previous result', () => {
  // A body that both lacks a mandatory section and is over the evidence limit: the old result, and no new output.
  const body = evidenceBody({ testEvidence: 'x'.repeat(PR_EVIDENCE_SECTION_MAX_BYTES + 1) }).replace('## Scenario Walkthrough', '## Walkthrough');
  const required = runLint(requiredRepo(), body);
  // The same body where the new checks cannot run at all (a cwd that is not a git repo) gives the previous result.
  const hermetic = { cwd: makeTempDir('pr-body-evidence-hermetic-') };
  tempRoots.push(hermetic.cwd);
  const previous = runLint(hermetic, body, { branch: 'chore/hermetic-pr-body-check' });
  assert.equal(required.status, 1);
  assert.equal(required.status, previous.status);
  assert.equal(required.stdout, previous.stdout);
  assert.equal(required.stderr, previous.stderr);
  assert.match(required.stderr, /ERROR: PR body missing canonical template phrases\nMissing:\n  - ## Scenario Walkthrough\nReference: /);
  assert.doesNotMatch(required.stdout + required.stderr, /evidence-section|handoff builder/);
});

test('Scenario: Bodies rejected by the existing checks keep their previous result (cost override disclosure mismatch)', () => {
  withChangeUsageStateDir(() => {
    const changeName = 'evidence-lint-disclosure';
    const repo = makeRepo({ branch: `bugfix/${changeName}` });
    mkdirSync(path.join(repo.cwd, 'openspec', 'changes', changeName), { recursive: true });
    appendChangeUsageOverride({
      cwd: repo.cwd,
      changeName,
      session_id: 's1',
      at: '2026-01-01T00:00:00.000Z',
      thresholds: ['output'],
      head_ref_oid: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    });
    const body = evidenceBody({ testEvidence: 'x'.repeat(PR_EVIDENCE_SECTION_MAX_BYTES + 1) });
    const withRef = runLint(repo, body);
    git(repo.cwd, ['update-ref', '-d', `refs/remotes/origin/${repo.branch}`]);
    const withoutRef = runLint(repo, body);
    assert.equal(withRef.status, 1);
    assert.match(withRef.stderr, /Cost Circuit Breaker Overrides disclosure mismatch/);
    assert.equal(withRef.status, withoutRef.status);
    assert.equal(withRef.stdout, withoutRef.stdout);
    assert.equal(withRef.stderr, withoutRef.stderr);
    assert.doesNotMatch(withRef.stdout + withRef.stderr, /evidence-section|handoff builder/);
  });
});

test('evidence checks: stdout keeps the canonical OK line and adds the checked or skipped statement on exit 0', () => {
  const r = runLint(requiredRepo(), evidenceBody());
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^OK: PR body template canonical phrases present\nevidence-section checks: checked \(/);
  const skipped = runLint(requiredRepo(), evidenceBody(), { args: ['--pr-target-unresolved'] });
  assert.match(skipped.stdout, /^OK: PR body template canonical phrases present\nevidence-section checks: skipped \(not verified: /);
});

// ── Consistency between the lint and the handoff builder (NFR1) ───────────────

const CONSISTENCY_CONTRACT = JSON.parse(readFileSync(path.join(path.dirname(SCRIPT), 'tests/fixtures/pr-sticky-handoff-contract.json'), 'utf8'));
const BUILDER_PATH = path.resolve(path.dirname(SCRIPT), 'build-pr-sticky-handoff.mjs');

// Runs the real builder with stubbed live reads (same harness shape as the builder tests).
async function runBuilderOnBody(body) {
  const { assertCanonicalCarrierRoot, buildPrStickyHandoff } = await import(pathToFileURL(BUILDER_PATH).href);
  const branch = `feature/${SYNTHETIC_CHANGE}`;
  const changeDir = `openspec/changes/${SYNTHETIC_CHANGE}/`;
  const proposal = {
    path: `${changeDir}proposal.md`,
    content: 'head proposal blob',
    doneWhen: ['head state is carried'],
  };
  const builderBody = body;
  const rawDiff = CONSISTENCY_CONTRACT.review_material;
  const temp = mkdtempSync(path.join(os.tmpdir(), 'lint-builder-consistency-'));
  const fakeRepo = path.join(temp, 'repo');
  mkdirSync(fakeRepo);
  execFileSync('git', ['init', '-q'], { cwd: fakeRepo, env: GIT_ENV });
  const root = path.join(fakeRepo, 'notes', 'cross-review');
  mkdirSync(root, { recursive: true });
  const dependencies = {
    readPrMetadata: (number) => ({ number, repository_slug: 'synthetic/example', head_branch: branch, head_sha: 'e'.repeat(40), body: builderBody }),
    readProposalAtHead: () => proposal,
    readConsumerSecondReviewRules: () => '',
    buildEmbeddedReviewMaterial: (scope) => ({ changed_files_or_touch_list: ['docs/guide.md'], review_material: rawDiff, review_material_proof: canonicalEmbeddedReviewMaterialProof(scope, rawDiff) }),
    liveStickyAuthoritySnapshot: ({ pr_number }) => ({ repository_slug: 'synthetic/example', pr_number, completeness: { status: 'complete', pagination_exhausted: true, pages_fetched: 1 }, query_error: null, comments: [] }),
    assertCanonicalCarrierRoot: (candidate) => assertCanonicalCarrierRoot(candidate, fakeRepo),
  };
  try {
    const outputPath = await buildPrStickyHandoff({ argv: [String(70000000 + Math.floor(Math.random() * 1000000)), '--change', SYNTHETIC_CHANGE, '--carrier-root', root], primaryFamily: 'codex', dependencies });
    return { error: undefined, files: readdirSync(root).filter((name) => name === path.basename(outputPath)) };
  } catch (error) {
    return { error };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

// The three kinds the lint blocks: evidence over-limit or unfilled text (pr_evidence_invalid) and scope_summary bytes.
function builderRejectsInLintKinds(error) {
  if (!error) return false;
  if (error.classification === 'pr_evidence_invalid') return true;
  return error.classification === 'handoff_limit_exceeded' && /scope_summary/.test(error.message);
}

const CONSISTENCY_FIXTURES = [
  ['a clean body', evidenceBody(), false],
  ['Test Evidence at the limit', evidenceBody({ testEvidence: 'x'.repeat(PR_EVIDENCE_SECTION_MAX_BYTES) }), false],
  ['Test Evidence one byte over', evidenceBody({ testEvidence: 'x'.repeat(PR_EVIDENCE_SECTION_MAX_BYTES + 1) }), true],
  ['validation sections joined at the limit', evidenceBody({ ledger: ledgerForJoinedBytes(PR_EVIDENCE_SECTION_MAX_BYTES) }), false],
  ['validation sections joined one byte over', evidenceBody({ ledger: ledgerForJoinedBytes(PR_EVIDENCE_SECTION_MAX_BYTES + 1) }), true],
  ['CJK Test Evidence that fits', evidenceBody({ testEvidence: '漢'.repeat(Math.floor(PR_EVIDENCE_SECTION_MAX_BYTES / 3)) }), false],
  ['CJK Test Evidence one character over', evidenceBody({ testEvidence: '漢'.repeat(Math.floor(PR_EVIDENCE_SECTION_MAX_BYTES / 3) + 1) }), true],
  ...Object.entries(BANNED).flatMap(([key, word]) => [
    [`banned word ${key} in Test Evidence`, evidenceBody({ testEvidence: `- 結果：${word} remains` }), true],
    [`banned word ${key} in the ledger`, evidenceBody({ ledger: `${COUNTS_LINE}\n- note: ${word} remains` }), true],
  ]),
  ['command template in inline code', evidenceBody({ testEvidence: `- 指令：${TICK}--changed <tested-sha>${TICK}` }), false],
  ['command template in a fenced block', evidenceBody({ testEvidence: `${FENCE}\nnode check <sha>\n${FENCE}` }), false],
  ['spaced field in inline code', evidenceBody({ testEvidence: `- ${TICK}<passed X, failed 0>${TICK}` }), true],
  ['field outside code', evidenceBody({ testEvidence: '- passed <n> checks' }), true],
  ['unclosed fence in OpenSpec and a field outside code in the ledger', evidenceBody({
    openspec: `${OPENSPEC_LINE}\n${FENCE}\nnode check --changed`,
    ledger: `${COUNTS_LINE}\n- follow-up: implemented <n>`,
  }), true],
  ['unclosed fence in OpenSpec and a command template in code in the ledger', evidenceBody({
    openspec: `${OPENSPEC_LINE}\n${FENCE}\nnode check --changed`,
    ledger: `${COUNTS_LINE}\n- follow-up: ${TICK}<n>${TICK}`,
  }), false],
  ['Change Context at the limit', evidenceBody({ changeContext: 'a'.repeat(PR_CHANGE_CONTEXT_MAX_BYTES) }), false],
  ['Change Context one byte over', evidenceBody({ changeContext: 'a'.repeat(PR_CHANGE_CONTEXT_MAX_BYTES + 1) }), true],
  ['Change Context over only before normalization', evidenceBody({ changeContext: `- ${'a'.repeat(Math.floor(PR_CHANGE_CONTEXT_MAX_BYTES / 2) - 1)}\n- ${'a'.repeat(Math.floor(PR_CHANGE_CONTEXT_MAX_BYTES / 2) - 1)}` }), false],
  ['CJK Change Context one character over', evidenceBody({ changeContext: '漢'.repeat(Math.floor(PR_CHANGE_CONTEXT_MAX_BYTES / 3) + 1) }), true],
  ['identifier in code inside the Change Context', evidenceBody({ changeContext: `- 目的：explain ${TICK}<name>${TICK}` }), true],
  ['banned word in the Change Context', evidenceBody({ changeContext: `- 目的：${BANNED.one} later` }), true],
  ['bracketed fill marker only in the Change Context', evidenceBody({ changeContext: `- 目的：mention ${BANNED.three} later` }), false],
  ['every kind at once', evidenceBody({ testEvidence: `${BANNED.two} ${'x'.repeat(PR_EVIDENCE_SECTION_MAX_BYTES)}`, changeContext: 'a'.repeat(PR_CHANGE_CONTEXT_MAX_BYTES + 1) }), true],
];

test('Scenario: Lint and builder agree on the same body (lint exit 1 exactly when the builder rejects in the three kinds)', async () => {
  // Fixtures stay inside the three kinds the lint blocks; empty sections and control characters are builder-only.
  const repo = requiredRepo();
  for (const [label, body, expectedReject] of CONSISTENCY_FIXTURES) {
    const lint = runLint(repo, body);
    const builder = await runBuilderOnBody(body);
    assert.ok(lint.status === 0 || lint.status === 1, `${label}: unexpected lint exit ${lint.status}\n${lint.stderr}`);
    assert.equal(lint.status === 1, expectedReject, `${label}: lint exit ${lint.status}\nstderr: ${lint.stderr}`);
    assert.equal(builderRejectsInLintKinds(builder.error), expectedReject, `${label}: builder ${builder.error ? `${builder.error.classification}: ${builder.error.message}` : 'accepted the body'}`);
    if (!expectedReject) assert.equal(builder.error, undefined, `${label}: the builder must accept the body, not refuse it for another reason`);
    if (expectedReject) assert.match(lint.stderr, /rejected by the second-review handoff builder/, label);
  }
});

test('Scenario: Command templates in code pass and template residue is rejected (lint side)', async () => {
  const repo = requiredRepo();
  const accepted = evidenceBody({ testEvidence: `- ${TICK}--changed <tested-sha>${TICK} and ${TICK}<X.Y.Z>${TICK}` });
  const residue = evidenceBody({ testEvidence: `- ${TICK}<passed X, failed 0, skipped Y>${TICK} and implemented <n>` });
  assertPassedChecked(runLint(repo, accepted), 'command templates in code');
  assert.equal((await runBuilderOnBody(accepted)).error, undefined);
  assertBlockedByEvidenceChecks(runLint(repo, residue), 'template residue');
  assert.equal(builderRejectsInLintKinds((await runBuilderOnBody(residue)).error), true);
});

// --pr-cwd: the checkout the PR comes from, when it is not the session --cwd (the hook passes it after a leading
// `cd`). The evidence checks and the cost-override disclosure check follow it; the mandatory phrases do not depend on it.
const PR_CWD_OVER_LIMIT = () => evidenceBody({ testEvidence: 'x'.repeat(PR_EVIDENCE_SECTION_MAX_BYTES + 1) });

test('Scenario: A cd to an exempt checkout is not blocked by the evidence checks (lint --pr-cwd)', () => {
  const session = requiredRepo();
  const exempt = makeRepo({ branch: 'chore/tidy-pr-cwd' });
  // Control: without --pr-cwd the session checkout decides, and it needs a second review.
  assertBlockedByEvidenceChecks(runLint(session, PR_CWD_OVER_LIMIT()), 'control without --pr-cwd');
  assertSkipped(runLint(session, PR_CWD_OVER_LIMIT(), { args: ['--pr-cwd', exempt.cwd] }), /evidence-section checks: skipped \(exempt: diff-shape: chore\/ 前綴車道/, '--pr-cwd names an exempt checkout');
});

test('Scenario: A cd to a checkout that needs second review is blocked by the evidence checks (lint --pr-cwd)', () => {
  const exemptSession = makeRepo({ branch: 'chore/tidy-session' });
  const target = makeRepo({ branch: 'feature/pr-cwd-target' });
  // Control: the exempt session checkout alone does not block.
  assertSkipped(runLint(exemptSession, PR_CWD_OVER_LIMIT()), /exempt: /, 'control without --pr-cwd');
  const blocked = runLint(exemptSession, PR_CWD_OVER_LIMIT(), { args: ['--pr-cwd', target.cwd] });
  assertBlockedByEvidenceChecks(blocked, '--pr-cwd names a checkout that needs second review');
  assert.match(blocked.stderr, /branch=feature\/pr-cwd-target; base=origin\/main; changed files=1/);
  // A clean body passes and says which checkout was checked.
  const clean = runLint(exemptSession, evidenceBody(), { args: ['--pr-cwd', target.cwd] });
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /evidence-section checks: checked \(second review required; branch=feature\/pr-cwd-target/);
});

test('Scenario: An unresolvable cwd is not blocked by the evidence checks and the existing checks still block (lint --pr-cwd)', () => {
  const session = requiredRepo();
  // --pr-cwd that is detached HEAD, not a git directory, or does not exist: the PR checkout is unknown, so fail open.
  const detached = makeRepo({ branch: 'feature/pr-cwd-detached' });
  git(detached.cwd, ['checkout', '-q', '--detach']);
  assertSkipped(runLint(session, PR_CWD_OVER_LIMIT(), { args: ['--pr-cwd', detached.cwd] }), /not verified: .*(detached|unavailable)/, '--pr-cwd detached HEAD');
  const notGit = makeTempDir('pr-body-evidence-pr-cwd-norepo-');
  tempRoots.push(notGit);
  assertSkipped(runLint(session, PR_CWD_OVER_LIMIT(), { args: ['--pr-cwd', notGit] }), /evidence-section checks: skipped \(not verified: /, '--pr-cwd not a git directory');
  assertSkipped(runLint(session, PR_CWD_OVER_LIMIT(), { args: ['--pr-cwd', path.join(notGit, 'missing')] }), /evidence-section checks: skipped \(not verified: /, '--pr-cwd missing directory');
  // --pr-target-unresolved still wins over --pr-cwd.
  const target = makeRepo({ branch: 'feature/pr-cwd-unresolved' });
  assertSkipped(runLint(session, PR_CWD_OVER_LIMIT(), { args: ['--pr-cwd', target.cwd, '--pr-target-unresolved'] }), /not verified: .*not a literal value/, 'unresolved target with --pr-cwd');
  // The mandatory phrases do not depend on the checkout: a missing section still exits 1 with the old message.
  const missing = runLint(session, evidenceBody().replace('## Scenario Walkthrough', '## Other'), { args: ['--pr-cwd', detached.cwd] });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /missing canonical template phrases/);
  assert.doesNotMatch(missing.stderr, /pr-cwd/);
});

// Cost-override disclosure follows the PR, not the session (fix-override-disclosure-pr-target): the head is --pr-head,
// else the branch of --pr-cwd, else --branch / the branch of --cwd; the change folder is looked up in --pr-cwd, else --cwd.
const DISCLOSURE_AT = '2026-01-01T00:00:00.000Z';
const disclosureLine = (oid) => `- at=2026-01-01T00:00:00Z thresholds=output head_ref_oid=${oid}`;
const disclosureBody = (oid) => evidenceBody().replace('## Cost Circuit Breaker Overrides\n- N/A', `## Cost Circuit Breaker Overrides\n${disclosureLine(oid)}`);
const SESSION_OID = 'a'.repeat(40);
const TARGET_OID = 'b'.repeat(40);

// A pushed checkout on bugfix/<changeName> whose change folder exists, with one override recorded at `oid` (or none).
function disclosureRepo(changeName, oid) {
  const repo = makeRepo({ branch: `bugfix/${changeName}` });
  mkdirSync(path.join(repo.cwd, 'openspec', 'changes', changeName), { recursive: true });
  if (oid) {
    appendChangeUsageOverride({ cwd: repo.cwd, changeName, session_id: 's1', at: DISCLOSURE_AT, thresholds: ['output'], head_ref_oid: oid });
  }
  return repo;
}

function assertDisclosureBlocked(r, oid, label) {
  assert.equal(r.status, 1, `${label}: expected exit 1\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stderr, /Cost Circuit Breaker Overrides disclosure mismatch/, label);
  assert.ok(r.stderr.includes(disclosureLine(oid)), `${label}: the expected lines must come from that checkpoint\nstderr: ${r.stderr}`);
}

function assertDisclosureSkipped(r, reason, label) {
  assert.equal(r.status, 0, `${label}: expected exit 0\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stderr, new RegExp(`ADVISORY: ${reason}.*override disclosure cross-check skipped \\(not claimed pass\\)`), label);
  assert.doesNotMatch(r.stderr, /disclosure mismatch/, label);
}

test('Scenario: A cd to another checkout moves the cost-override disclosure check (lint --pr-cwd)', () => {
  withChangeUsageStateDir(() => {
    const session = disclosureRepo('disclosure-session-a', SESSION_OID);
    const target = disclosureRepo('disclosure-target-b', TARGET_OID);
    // Control: without --pr-cwd the session checkpoint decides.
    assert.equal(runLint(session, disclosureBody(SESSION_OID)).status, 0, 'control: the session line passes in the session checkout');
    assertDisclosureBlocked(runLint(session, evidenceBody()), SESSION_OID, 'control: N/A blocks in the session checkout');
    // With --pr-cwd the target checkpoint decides: its line passes, the session line and N/A block and print its line.
    const args = ['--pr-cwd', target.cwd];
    const passed = runLint(session, disclosureBody(TARGET_OID), { args });
    assert.equal(passed.status, 0, `the target line passes\nstderr: ${passed.stderr}`);
    assert.doesNotMatch(passed.stderr, /override disclosure cross-check skipped/);
    assertDisclosureBlocked(runLint(session, disclosureBody(SESSION_OID), { args }), TARGET_OID, 'the session line under --pr-cwd');
    assertDisclosureBlocked(runLint(session, evidenceBody(), { args }), TARGET_OID, 'N/A under --pr-cwd');
  });
});

test('Scenario: A cd to a checkout without a checkpoint skips the cost-override disclosure check (lint --pr-cwd)', () => {
  withChangeUsageStateDir(() => {
    const session = disclosureRepo('disclosure-session-only', SESSION_OID);
    const target = disclosureRepo('disclosure-target-none', null);
    assertDisclosureBlocked(runLint(session, evidenceBody()), SESSION_OID, 'control: N/A blocks in the session checkout');
    assertDisclosureSkipped(runLint(session, evidenceBody(), { args: ['--pr-cwd', target.cwd] }), 'checkpoint unavailable', 'target without a checkpoint');
    // A --pr-cwd whose branch cannot be read never falls back to the session branch.
    const detached = disclosureRepo('disclosure-target-detached', TARGET_OID);
    git(detached.cwd, ['checkout', '-q', '--detach']);
    assertDisclosureSkipped(runLint(session, evidenceBody(), { args: ['--pr-cwd', detached.cwd] }), 'branch unavailable', '--pr-cwd detached HEAD');
    const notGit = makeTempDir('pr-body-disclosure-pr-cwd-norepo-');
    tempRoots.push(notGit);
    assertDisclosureSkipped(runLint(session, evidenceBody(), { args: ['--pr-cwd', notGit] }), 'branch unavailable', '--pr-cwd not a git directory');
  });
});

test('Scenario: The PR head names the cost-override disclosure branch (lint --pr-head)', () => {
  withChangeUsageStateDir(() => {
    const session = disclosureRepo('disclosure-head-session', SESSION_OID);
    // --pr-head names a branch whose change folder is not in the session checkout: its checkpoint cannot be read.
    disclosureRepo('disclosure-head-elsewhere', TARGET_OID);
    assertDisclosureSkipped(
      runLint(session, evidenceBody(), { args: ['--pr-head', 'bugfix/disclosure-head-elsewhere'] }),
      'checkpoint unavailable',
      '--pr-head whose change folder is elsewhere',
    );
    // With its change folder in the checkout, the --pr-head checkpoint decides.
    const changeName = 'disclosure-head-here';
    mkdirSync(path.join(session.cwd, 'openspec', 'changes', changeName), { recursive: true });
    appendChangeUsageOverride({ cwd: session.cwd, changeName, session_id: 's1', at: DISCLOSURE_AT, thresholds: ['output'], head_ref_oid: TARGET_OID });
    const args = ['--pr-head', `bugfix/${changeName}`];
    assert.equal(runLint(session, disclosureBody(TARGET_OID), { args }).status, 0, 'the --pr-head line passes');
    assertDisclosureBlocked(runLint(session, disclosureBody(SESSION_OID), { args }), TARGET_OID, 'the session line under --pr-head');
  });
});

test('Scenario: An unresolved PR target skips the cost-override disclosure check (lint --pr-target-unresolved)', () => {
  withChangeUsageStateDir(() => {
    const session = disclosureRepo('disclosure-unresolved', SESSION_OID);
    assertDisclosureBlocked(runLint(session, evidenceBody()), SESSION_OID, 'control: N/A blocks in the session checkout');
    // The hook passes the flag for a non-literal --head or --base, an earlier branch switch, or an unresolvable cd;
    // the check then skips even in the session checkout.
    assertDisclosureSkipped(runLint(session, evidenceBody(), { args: ['--pr-target-unresolved'] }), 'PR target unresolved', 'unresolved target');
  });
});

test('evidence checks: --pr-cwd equal to --cwd, and no --pr-cwd, give the same result', () => {
  const session = requiredRepo();
  const withoutFlag = runLint(session, PR_CWD_OVER_LIMIT());
  const sameDir = runLint(session, PR_CWD_OVER_LIMIT(), { args: ['--pr-cwd', session.cwd] });
  assert.equal(withoutFlag.status, 1);
  assert.equal(sameDir.status, withoutFlag.status);
  assert.equal(sameDir.stderr, withoutFlag.stderr);
  assertPassedChecked(runLint(session, evidenceBody(), { args: ['--pr-cwd', session.cwd] }), '--pr-cwd equal to --cwd');
});

// ── Retired disclosure notice section (remove-second-review-disclosure-framework, design D3) ──
//
// The lint no longer asks a required PR for a notice section, and a section left behind by an older PR body is not read.

const RETIRED_NOTICE_HEADING = '## Second-Review Disclosure Notice';
const RETIRED_NOTICE_VARIANTS = [
  { label: 'without a notice section', extraSections: [] },
  { label: 'with a leftover notice section', extraSections: [RETIRED_NOTICE_HEADING, '舊 PR 留下的任意說明文字', ''] },
  { label: 'with an empty leftover notice section', extraSections: [RETIRED_NOTICE_HEADING, ''] },
];

test('Required verdict no longer asks for a disclosure notice section', () => {
  const repo = requiredRepo();
  for (const { label, extraSections } of RETIRED_NOTICE_VARIANTS) {
    const r = runLint(repo, evidenceBody({ extraSections }));
    assertPassedChecked(r, `required ${label}`);
    assert.doesNotMatch(r.stderr, /disclosure notice/i, `required ${label}: no notice finding`);
  }
  // Evidence findings still block, and they are the only finding.
  const over = runLint(repo, evidenceBody({ testEvidence: 'x'.repeat(PR_EVIDENCE_SECTION_MAX_BYTES + 1) }));
  assert.equal(over.status, 1);
  assert.match(over.stderr, /rejected by the second-review handoff builder/);
  assert.doesNotMatch(over.stderr, /disclosure notice/i);
});

test('Exempt and unknown verdicts keep their fail-open result without a notice section', () => {
  const exempt = makeRepo({ branch: 'chore/tidy-notice-exempt' });
  for (const { label, extraSections } of RETIRED_NOTICE_VARIANTS) {
    assertSkipped(runLint(exempt, evidenceBody({ extraSections })), /evidence-section checks: skipped \(exempt: diff-shape: chore\/ 前綴車道/, `exempt ${label}`);
  }
  const repo = requiredRepo();
  const unresolved = runLint(repo, evidenceBody(), { args: ['--pr-target-unresolved'] });
  assertSkipped(unresolved, /evidence-section checks: skipped \(not verified: /, 'unknown (target unresolved)');
});

test('PR templates no longer carry the retired disclosure notice section', () => {
  const ruleText = readFileSync(repoPath('.devpro/agent-rules/git-pr-template-and-merge.md'), 'utf8');
  const templates = [
    ['.github/PULL_REQUEST_TEMPLATE.md', readFileSync(repoPath('.github/PULL_REQUEST_TEMPLATE.md'), 'utf8')],
    ['git-pr-template-and-merge.md', ruleText],
  ];
  for (const [label, text] of templates) {
    assert.equal(text.includes('Second-Review Disclosure Notice'), false, `${label}: the retired notice heading is gone`);
    assert.equal(text.includes('依採用 devpro-agent-rules 之告知'), false, `${label}: the retired notice line is gone`);
  }
});

// ── OpenSpec archive line ──────────────────────────────────────────────────────


function runArchiveVariant(replacement) {
  const body = FULL_BODY.replace('- archive: done', replacement);
  const { dir, file } = writeTempBody(body);
  try { return run(file); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('[Scenario: openspec-flow :: Outcome shapes pass and an absent line stays optional] archive line: done passes', () => {
  const result = runArchiveVariant('- archive: done（openspec/specs/demo/）');
  assert.equal(result.status, 0, result.stderr);
});

test('[Scenario: openspec-flow :: A pending archive line fails with the offending line named] archive line: pending fails and names the offending line', () => {
  const result = runArchiveVariant('- archive: pending（lite；later）');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /OpenSpec archive line does not record an outcome/);
  assert.match(result.stderr, /pending/);
});

test('archive line: absence stays optional', () => {
  const body = FULL_BODY.replace('- archive: done\n', '');
  const { dir, file } = writeTempBody(body);
  try {
    assert.equal(run(file).status, 0, 'a body without the archive line must keep passing');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('archive line: N/A without a reason fails, with a reason passes', () => {
  assert.notEqual(runArchiveVariant('- archive: N/A').status, 0);
  assert.notEqual(runArchiveVariant('- archive: N/A:').status, 0);
  assert.equal(runArchiveVariant('- archive: N/A: rules lane sync, no change folder').status, 0);
});

test('archive line: deferred needs a named reason', () => {
  assert.notEqual(runArchiveVariant('- archive: deferred').status, 0);
  assert.equal(runArchiveVariant('- archive: deferred — urgent hotfix, 24h 內補齊').status, 0);
});

test('archive line: bare, bullet and checkbox forms are all seen', () => {
  const bare = FULL_BODY.replace('- archive: done', 'archive: pending');
  const { dir, file } = writeTempBody(bare);
  try {
    const result = run(file);
    assert.notEqual(result.status, 0, 'a bare archive: line must be validated too');
    assert.match(result.stderr, /OpenSpec archive line does not record an outcome/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.notEqual(runArchiveVariant('- [ ] archive: pending').status, 0);
});

test('archive line: a value that still says pending is rejected whatever the wrapper', () => {
  assert.notEqual(runArchiveVariant('- archive: deferred — pending').status, 0);
  assert.notEqual(runArchiveVariant('- archive: N/A: pending').status, 0);
});

test('archive line: a named reason may contain the word pending', () => {
  assert.equal(runArchiveVariant('- archive: deferred — pending upstream fix').status, 0);
  assert.equal(runArchiveVariant('- archive: N/A: no pending change folder').status, 0);
});

test('archive line: wrapped pending negatives fail with the archive-line error, not just any nonzero', () => {
  for (const variant of ['- archive: deferred — pending', '- archive: N/A: pending', '- [ ] archive: pending']) {
    const result = runArchiveVariant(variant);
    assert.notEqual(result.status, 0, variant);
    assert.match(result.stderr, /OpenSpec archive line does not record an outcome/, variant);
    assert.match(result.stderr, /offending line:/, variant);
  }
});

test('archive line: a done line that still says pending is rejected', () => {
  const result = runArchiveVariant('- archive: done — but pending');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /OpenSpec archive line does not record an outcome/);
  assert.equal(runArchiveVariant('- archive: done（openspec/specs/demo/）').status, 0);
});
