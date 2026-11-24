/**
 * recap-body-template-check.test.mjs
 *
 * Tests for .devpro/scripts/recap-body-template-check.mjs
 *
 * Fixture bodies are inline strings to avoid scattered fixture files.
 * Script is invoked via spawnSync with --body-file <tmpfile>.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from './lib/tmp.mjs';

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../recap-body-template-check.mjs'
);

/** Write a body string to a temp file; caller is responsible for cleanup. */
function writeTempBody(content) {
  const dir = makeTempDir('recap-body-check-');
  const file = path.join(dir, 'body.md');
  writeFileSync(file, content, 'utf8');
  return { dir, file };
}

function run(file) {
  return spawnSync('node', [SCRIPT, '--body-file', file], { encoding: 'utf8' });
}

// ── Canonical full-body fixture ────────────────────────────────────────────────

const FULL_BODY = `
## Branch
chore/enforce-recap-body-structure-via-lint-and-hook (PR #420, merged → main)

## 完成項
- 新增 recap-body-template-check.mjs lint script
- 新增 pre-tool-gate createDiscussion body lint gate
- 完整測試 ≥8 cases

## Requirement Ledger Completion
- disposition counts: implemented 1, partial 0, deferred 0, rejected 0, moved-to-issue 0
- non-implemented rows: N/A

## 卡關點
- 無

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

function structuredLineageBody(overrides = {}) {
  const fields = {
    schema: 'devpro-lineage-usage-report/v1',
    lookup: 'exact',
    scope: 'current-change',
    coverage: 'lineage-complete',
    terminality: 'terminal',
    reconciliation: 'reconciled',
    claims: 'current-change, lineage-complete, final, reconciled',
    root_sessions: '1',
    descendant_sessions: '1',
    external_reviewer_sessions: '1',
    dispatch_rows: '1',
    spawn_events: '1',
    root_totals: 'input 100 / output 50',
    descendant_totals: 'input 10 / output 5',
    external_reviewer_totals: 'input 5 / output 2',
    lineage_totals: 'input 115 / output 57',
    efficiency_verdict: 'not-comparable',
    baseline: 'N/A: no equivalent baseline measurement',
    quota_impact: 'N/A: provider does not expose quota impact',
    quota_authority: 'N/A: provider does not expose quota authority',
    gaps: 'none',
    ...overrides,
  };
  const structuredFields = Object.entries(fields)
    .map(([key, value]) => `- ${key}: ${value}`)
    .join('\n');
  return FULL_BODY.replace('- gaps: 無', structuredFields);
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test('case 1 (PASS): body 含三必填 H2，無 anti-pattern → exit 0, stdout OK', () => {
  const { dir, file } = writeTempBody(FULL_BODY);
  try {
    const r = run(file);
    assert.equal(r.status, 0, `Expected exit 0, got ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /OK: Recap body canonical structure verified/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 2 (FAIL): 缺 ## Branch → exit 1, stderr 列 ## Branch', () => {
  const body = FULL_BODY.replace(/^## Branch.*$/m, '## 分支');
  const { dir, file } = writeTempBody(body);
  try {
    const r = run(file);
    assert.equal(r.status, 1, `Expected exit 1, got ${r.status}`);
    assert.match(r.stderr, /ERROR: Recap body violates canonical structure/);
    assert.ok(
      r.stderr.includes('## Branch'),
      `stderr should list '## Branch' as missing\nActual stderr: ${r.stderr}`
    );
    assert.match(r.stderr, /Reference:.*session-recap\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 3 (FAIL): 缺 ## 完成項 → exit 1, stderr 列 ## 完成項', () => {
  const body = FULL_BODY.replace('## 完成項', '## Done');
  const { dir, file } = writeTempBody(body);
  try {
    const r = run(file);
    assert.equal(r.status, 1, `Expected exit 1, got ${r.status}`);
    assert.match(r.stderr, /ERROR: Recap body violates canonical structure/);
    assert.ok(
      r.stderr.includes('## 完成項'),
      `stderr should list '## 完成項' as missing\nActual stderr: ${r.stderr}`
    );
    // ## Branch and ## 版本資訊 are present — must NOT be listed as missing
    assert.ok(
      !r.stderr.includes('## Branch\n') && !r.stderr.includes('  - ## Branch'),
      `stderr should NOT list '## Branch' as missing when it is present\nActual stderr: ${r.stderr}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 3a (FAIL): Requirement Ledger Completion empty → exit 1', () => {
  const body = FULL_BODY.replace(
    /## Requirement Ledger Completion[\s\S]*?## 卡關點/,
    '## Requirement Ledger Completion\n\n## 卡關點'
  );
  const { dir, file } = writeTempBody(body);
  try {
    const r = run(file);
    assert.equal(r.status, 1, `Expected exit 1, got ${r.status}`);
    assert.match(r.stderr, /Invalid section content/);
    assert.match(r.stderr, /disposition counts or N\/A/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 3b (FAIL): Requirement Ledger Completion tasks checked only → exit 1', () => {
  const body = FULL_BODY.replace(
    /## Requirement Ledger Completion[\s\S]*?## 卡關點/,
    '## Requirement Ledger Completion\n- tasks checked\n\n## 卡關點'
  );
  const { dir, file } = writeTempBody(body);
  try {
    const r = run(file);
    assert.equal(r.status, 1, `Expected exit 1, got ${r.status}`);
    assert.match(r.stderr, /Invalid section content/);
    assert.match(r.stderr, /disposition counts or N\/A/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 3c (FAIL): Requirement Ledger Completion all done only → exit 1', () => {
  const body = FULL_BODY.replace(
    /## Requirement Ledger Completion[\s\S]*?## 卡關點/,
    '## Requirement Ledger Completion\n- all done\n\n## 卡關點'
  );
  const { dir, file } = writeTempBody(body);
  try {
    const r = run(file);
    assert.equal(r.status, 1, `Expected exit 1, got ${r.status}`);
    assert.match(r.stderr, /Invalid section content/);
    assert.match(r.stderr, /disposition counts or N\/A/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 3d (PASS): Requirement Ledger Completion N/A with reason → exit 0', () => {
  const body = FULL_BODY.replace(
    /## Requirement Ledger Completion[\s\S]*?## 卡關點/,
    '## Requirement Ledger Completion\nN/A: chore A with no OpenSpec ledger\n\n## 卡關點'
  );
  const { dir, file } = writeTempBody(body);
  try {
    const r = run(file);
    assert.equal(r.status, 0, `Expected exit 0, got ${r.status}\nstderr: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 4 (FAIL): 含 anti-pattern ## Context，三必填齊全 → exit 1, stderr 列 ## Context', () => {
  const body = FULL_BODY + '\n\n## Context\nSome context here.';
  const { dir, file } = writeTempBody(body);
  try {
    const r = run(file);
    assert.equal(r.status, 1, `Expected exit 1, got ${r.status}`);
    assert.match(r.stderr, /ERROR: Recap body violates canonical structure/);
    assert.ok(
      r.stderr.includes('## Context'),
      `stderr should list anti-pattern '## Context'\nActual stderr: ${r.stderr}`
    );
    assert.match(r.stderr, /Anti-pattern H2/);
    assert.match(r.stderr, /Reference:.*session-recap\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 5 (FAIL): empty body file → exit 2', () => {
  const { dir, file } = writeTempBody('');
  try {
    const r = run(file);
    assert.equal(r.status, 2, `Expected exit 2, got ${r.status}`);
    assert.match(r.stderr, /ERROR: Recap body input is empty or unreadable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 6 (FAIL): 缺 ## 完成項 + 含 ## Lessons → exit 1, stderr 同時列兩者', () => {
  const body = FULL_BODY.replace('## 完成項', '## Done') + '\n\n## Lessons\nLearned a lot.';
  const { dir, file } = writeTempBody(body);
  try {
    const r = run(file);
    assert.equal(r.status, 1, `Expected exit 1, got ${r.status}`);
    assert.match(r.stderr, /Missing required H2/);
    assert.ok(
      r.stderr.includes('## 完成項'),
      `stderr should list missing '## 完成項'\nActual stderr: ${r.stderr}`
    );
    assert.match(r.stderr, /Anti-pattern H2/);
    assert.ok(
      r.stderr.includes('## Lessons'),
      `stderr should list anti-pattern '## Lessons'\nActual stderr: ${r.stderr}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 7 (PASS): ## Test Evidence 不是 anti-pattern，不應誤擋', () => {
  // ## Test Evidence is a PR body heading, not a Recap anti-pattern
  const body = FULL_BODY + '\n\n## Test Evidence\n- node --test passed';
  const { dir, file } = writeTempBody(body);
  try {
    const r = run(file);
    assert.equal(r.status, 0, `Expected exit 0 (Test Evidence is NOT anti-pattern), got ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /OK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── hasTokenSpendRecord (T14) ────────────────────────────────────────────────

test('case 8 (FAIL): PR #2364 舊欄位骨架（無 host/session/source）→ exit 1', () => {
  const body = FULL_BODY.replace(
    /## Token 回顧[\s\S]*?## 版本資訊/,
    [
      '## Token 回顧',
      '- rule_load_bytes: N/A',
      '- rule_load_tokens_est: N/A',
      '- duplicate_rule_reads: 0',
      '- output_line_byte_count: N/A',
      '- cached_tokens: N/A',
      '- savings_claim_type: N/A',
      '- actual_vs_baseline: N/A',
      '',
      '## 版本資訊',
    ].join('\n')
  );
  const { dir, file } = writeTempBody(body);
  try {
    const r = run(file);
    assert.equal(r.status, 1, `Expected exit 1, got ${r.status}`);
    assert.match(r.stderr, /Invalid section content/);
    assert.match(r.stderr, /Token 回顧/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 9 (PASS): source: N/A: host does not expose usage data → exit 0', () => {
  const body = FULL_BODY.replace(
    /## Token 回顧[\s\S]*?## 版本資訊/,
    [
      '## Token 回顧',
      '- host: gemini',
      '- session: n/a (host has no session concept)',
      '- source: N/A: host does not expose usage data',
      '- totals: N/A',
      '- cost_usd: N/A',
      '- gaps: N/A',
      '',
      '## 版本資訊',
    ].join('\n')
  );
  const { dir, file } = writeTempBody(body);
  try {
    const r = run(file);
    assert.equal(r.status, 0, `Expected exit 0, got ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /OK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 10 (FAIL): 缺 session: → exit 1', () => {
  const body = FULL_BODY.replace(/^- session: .*$/m, '');
  const { dir, file } = writeTempBody(body);
  try {
    const r = run(file);
    assert.equal(r.status, 1, `Expected exit 1, got ${r.status}`);
    assert.match(r.stderr, /Invalid section content/);
    assert.match(r.stderr, /Token 回顧/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 11 (FAIL): host: auto → exit 1, reason 具名 auto 不是 host 識別字', () => {
  const body = FULL_BODY.replace(/^- host: .*$/m, '- host: auto');
  const { dir, file } = writeTempBody(body);
  try {
    const r = run(file);
    assert.equal(r.status, 1, `Expected exit 1, got ${r.status}`);
    assert.match(r.stderr, /Invalid section content/);
    assert.match(r.stderr, /auto/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// F-I7: cost_usd:/gaps: are enforced (non-empty) for the same reason
// host:/session:/source:/totals: already are, when source is not N/A.
test('case 12 (FAIL, F-I7): 缺 cost_usd: (source 非 N/A) → exit 1', () => {
  const body = FULL_BODY.replace(/^- cost_usd: .*$/m, '');
  const { dir, file } = writeTempBody(body);
  try {
    const r = run(file);
    assert.equal(r.status, 1, `Expected exit 1, got ${r.status}`);
    assert.match(r.stderr, /Invalid section content/);
    assert.match(r.stderr, /cost_usd/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 13 (FAIL, F-I7): 缺 gaps: (source 非 N/A) → exit 1', () => {
  const body = FULL_BODY.replace(/^- gaps: .*$/m, '');
  const { dir, file } = writeTempBody(body);
  try {
    const r = run(file);
    assert.equal(r.status, 1, `Expected exit 1, got ${r.status}`);
    assert.match(r.stderr, /Invalid section content/);
    assert.match(r.stderr, /gaps/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 14 (PASS, F-I7): source: N/A 時 cost_usd:/gaps: 仍可為 N/A 或缺席 → exit 0', () => {
  const body = FULL_BODY.replace(
    /## Token 回顧[\s\S]*?## 版本資訊/,
    [
      '## Token 回顧',
      '- host: gemini',
      '- session: n/a (host has no session concept)',
      '- source: N/A: host does not expose usage data',
      '',
      '## 版本資訊',
    ].join('\n')
  );
  const { dir, file } = writeTempBody(body);
  try {
    const r = run(file);
    assert.equal(r.status, 0, `Expected exit 0, got ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /OK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 15 (FAIL, F-PR-RECAP-LINT): source: N/A: 無理由 → exit 1', () => {
  const body = FULL_BODY.replace(
    /## Token 回顧[\s\S]*?## 版本資訊/,
    [
      '## Token 回顧',
      '- host: gemini',
      '- session: n/a',
      '- source: N/A:',
      '',
      '## 版本資訊',
    ].join('\n')
  );
  const { dir, file } = writeTempBody(body);
  try {
    const r = run(file);
    assert.equal(r.status, 1, `Expected exit 1, got ${r.status}`);
    assert.match(r.stderr, /non-empty reason/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 16 (FAIL, F-PR-RECAP-LINT): detail table placeholder row (非 8 欄) → exit 1', () => {
  const body = FULL_BODY.replace(
    '| 10:00:00 | 5s | main | 實作 T1 | 6000 | 4000 | 2000 | 0 |',
    '| 10:00:00 | 5s | main | 實作 T1 | 6000 | 4000 |',
  );
  const { dir, file } = writeTempBody(body);
  try {
    const r = run(file);
    assert.equal(r.status, 1, `Expected exit 1, got ${r.status}`);
    assert.match(r.stderr, /detail table row/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 17 (PASS, F-PR-RECAP-LINT): detail table row 含 escaped pipe 仍為 8 欄 → exit 0', () => {
  const body = FULL_BODY.replace(
    '| 10:00:00 | 5s | main | 實作 T1 | 6000 | 4000 | 2000 | 0 |',
    '| 10:00:00 | 5s | main | step \\| split | 6000 | 4000 | 2000 | 0 |',
  );
  const { dir, file } = writeTempBody(body);
  try {
    const r = run(file);
    assert.equal(r.status, 0, `Expected exit 0, got ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /OK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 18 (FAIL, F-PR-RECAP-PIPE): even backslash run (`\\\\|`) is a real delimiter → 9 欄 exit 1', () => {
  const body = FULL_BODY.replace(
    '| 10:00:00 | 5s | main | 實作 T1 | 6000 | 4000 | 2000 | 0 |',
    '| 10:00:00 | 5s | main | a \\\\| b | 6000 | 4000 | 2000 | 0 |',
  );
  const { dir, file } = writeTempBody(body);
  try {
    const r = run(file);
    assert.equal(r.status, 1, `Expected exit 1, got ${r.status}`);
    assert.match(r.stderr, /detail table row/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 19 (PASS, F-PR-RECAP-PIPE): odd backslash run (`\\\\\\|`) keeps escaped pipe → 8 欄 exit 0', () => {
  const body = FULL_BODY.replace(
    '| 10:00:00 | 5s | main | 實作 T1 | 6000 | 4000 | 2000 | 0 |',
    '| 10:00:00 | 5s | main | x \\\\\\| y | 6000 | 4000 | 2000 | 0 |',
  );
  const { dir, file } = writeTempBody(body);
  try {
    const r = run(file);
    assert.equal(r.status, 0, `Expected exit 0 with parity-aware counting, got ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /OK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── T10: structured lineage claim-integrity prove-it RED ────────────────────

for (const negative of [
  {
    name: 'spawn events without descendant evidence or a named gap',
    overrides: {
      descendant_sessions: '0',
      descendant_totals: 'input 0 / output 0',
      lineage_totals: 'input 105 / output 52',
    },
    reason: /descendant_sessions|descendant evidence/i,
  },
  {
    name: 'mixed-session scope with a current-change claim',
    overrides: { scope: 'mixed-session' },
    reason: /scope.*mixed-session|current-change.*scope/i,
  },
  {
    name: 'open terminality with a final claim',
    overrides: { terminality: 'open' },
    reason: /terminality.*open|final.*terminality/i,
  },
  {
    name: 'metric mismatch with a reconciled claim',
    overrides: {
      reconciliation: 'gaps',
      lineage_totals: 'input 999 / output 57',
      gaps: 'reconciliation-input-mismatch',
    },
    reason: /reconciliation.*gaps|reconciled.*reconciliation|input.*mismatch/i,
  },
  {
    name: 'improved verdict without an equivalent baseline',
    overrides: { efficiency_verdict: 'improved' },
    reason: /equivalent baseline|baseline/i,
  },
  {
    name: 'numeric quota impact without provider authority',
    overrides: { quota_impact: '12.5%' },
    reason: /quota_authority|quota authority/i,
  },
]) {
  test(`T10 claim-integrity RED: ${negative.name}`, () => {
    const { dir, file } = writeTempBody(structuredLineageBody(negative.overrides));
    try {
      const r = run(file);
      assert.equal(r.status, 1, `Expected claim-integrity rejection, got ${r.status}`);
      assert.match(r.stderr, negative.reason);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('T10 compatibility: a consistent versioned lineage summary passes', () => {
  const { dir, file } = writeTempBody(structuredLineageBody());
  try {
    const r = run(file);
    assert.equal(r.status, 0, `Expected exit 0, got ${r.status}\nstderr: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T10 claim-integrity: source N/A cannot bypass a contradictory structured lineage summary', () => {
  const body = structuredLineageBody({
    scope: 'mixed-session',
    terminality: 'open',
    reconciliation: 'gaps',
    gaps: 'evidence-boundary-drift',
  }).replace('- source: 精準命中', '- source: N/A: host does not expose usage data');
  const { dir, file } = writeTempBody(body);
  try {
    const r = run(file);
    assert.equal(r.status, 1, `Expected N/A structured-claim rejection, got ${r.status}`);
    assert.match(r.stderr, /mixed-session|current-change|terminality|reconciliation/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T11 compatibility: a manifest rollup keeps dispatch rows separate from unique reviewer sessions', () => {
  const body = structuredLineageBody({
    external_reviewer_sessions: '2',
    dispatch_rows: '3',
    external_reviewer_totals: 'input 8 / output 4',
    lineage_totals: 'input 118 / output 59',
  });
  const { dir, file } = writeTempBody(body);
  try {
    const r = run(file);
    assert.equal(r.status, 0, `Expected exit 0, got ${r.status}\nstderr: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T11 compatibility: missing descendant evidence passes with an honest named gap and degraded coverage', () => {
  const body = structuredLineageBody({
    coverage: 'lineage-incomplete',
    claims: 'current-change, final, reconciled',
    descendant_sessions: '0',
    descendant_totals: 'input 0 / output 0',
    lineage_totals: 'input 105 / output 52',
    gaps: 'codex-descendant-usage-missing',
  });
  const { dir, file } = writeTempBody(body);
  try {
    const r = run(file);
    assert.equal(r.status, 0, `Expected exit 0, got ${r.status}\nstderr: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T11 claim-integrity: evidence-boundary drift blocks a reproduced status', () => {
  const body = structuredLineageBody({ gaps: 'evidence-boundary-drift' })
    .replace('- gaps: evidence-boundary-drift', '- evidence_status: reproduced\n- gaps: evidence-boundary-drift');
  const { dir, file } = writeTempBody(body);
  try {
    const r = run(file);
    assert.equal(r.status, 1, `Expected exit 1, got ${r.status}`);
    assert.match(r.stderr, /evidence_status.*reproduced.*evidence-boundary-drift/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T11 privacy: structured summary rejects a raw local path without echoing it', () => {
  const privateMarker = ['private', 'home', 'marker'].join('-');
  const rawPath = ['', 'Users', privateMarker, 'session.jsonl'].join('/');
  const { dir, file } = writeTempBody(structuredLineageBody({ gaps: `lineage-read-failed:${rawPath}` }));
  try {
    const r = run(file);
    assert.equal(r.status, 1, `Expected exit 1, got ${r.status}`);
    assert.match(r.stderr, /gaps: contains a disallowed raw path/i);
    assert.doesNotMatch(r.stderr, new RegExp(privateMarker));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T11 privacy: structured summary rejects an account marker without echoing it', () => {
  const localPart = ['private', 'account', 'marker'].join('.');
  const email = [localPart, 'example.test'].join('@');
  const { dir, file } = writeTempBody(structuredLineageBody({ baseline: email }));
  try {
    const r = run(file);
    assert.equal(r.status, 1, `Expected exit 1, got ${r.status}`);
    assert.match(r.stderr, /baseline: contains a disallowed raw path or account identifier/i);
    assert.doesNotMatch(r.stderr, new RegExp(localPart.replaceAll('.', '\\.')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
