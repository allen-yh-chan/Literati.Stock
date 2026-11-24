/**
 * rule-design-principles-meta-rule.test.mjs
 *
 * Meta-rule — rule-design-principles.md structural integrity tests.
 * Covers: P4 rationalize-ssot meta-rule requirements for the two major
 * sections added by chore enforce-hook-backed-rule-system-and-rationalize-ssot:
 *
 *   1. ## Hook-or-Don't-Add 守則 section (in rule-design-principles.md)
 *      - 4-dimension Hook-ability Matrix anchors
 *   2. ## Periodic Rationalization Cadence section (moved to rule-audit-playbook.md)
 *      - 4 trigger condition anchors (5 chore B / 5 minor bump / 6300 / 75%)
 *      - 4-task rationalization scope anchors
 *
 * Per P4 Meta-rule spec: rule-design-principles.md (design-only) +
 *   rule-audit-playbook.md (cadence/execution content moved by enforce-rationalization-loadpath)
 *
 * Test strategy:
 *   - Read the respective .md file from .devpro/agent-rules/
 *   - grep for specific anchors using string inclusion checks
 *   - Fail if any required anchor is missing
 *
 * Avoid dogfood loop: FORBIDDEN regex patterns (email/path) use RegExp
 * constructor (per Bundle B+C pattern) — no literal FORBIDDEN regex literals
 * in this file.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { repoPath } from './lib/repo-root.mjs';

const RULE_FILE = repoPath('.devpro/agent-rules/rule-design-principles.md');
const AUDIT_FILE = repoPath('.devpro/agent-rules/rule-audit-playbook.md');
const ARCHIVE_GATE_FILE = repoPath('.devpro/scripts/pre-pr-archive-gate.mjs');

function readRuleContent() {
  assert.ok(existsSync(RULE_FILE), `rule-design-principles.md must exist at: ${RULE_FILE}`);
  return readFileSync(RULE_FILE, 'utf8');
}

function readAuditContent() {
  assert.ok(existsSync(AUDIT_FILE), `rule-audit-playbook.md must exist at: ${AUDIT_FILE}`);
  return readFileSync(AUDIT_FILE, 'utf8');
}

function readArchiveGateContent() {
  assert.ok(existsSync(ARCHIVE_GATE_FILE), `pre-pr-archive-gate.mjs must exist at: ${ARCHIVE_GATE_FILE}`);
  return readFileSync(ARCHIVE_GATE_FILE, 'utf8');
}

function auditCadenceSection() {
  const content = readAuditContent();
  const start = content.indexOf('### Cadence');
  const end = content.indexOf('### Batch-approved', start);
  assert.ok(start >= 0 && end > start, 'must find the scoped Cadence section before Batch-approved');
  return content.slice(start, end);
}

// ─────────────────────────────────────────────────────────────────────────
// Test 1: ## Hook-or-Don't-Add heading exists
// ─────────────────────────────────────────────────────────────────────────

test('Meta-rule: rule-design-principles.md contains ## Hook-or-Don\'t-Add heading', () => {
  const content = readRuleContent();
  assert.ok(
    content.includes('## Hook-or-Don\'t-Add'),
    'must contain "## Hook-or-Don\'t-Add" section heading'
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Test 2: 4-dimension Hook-ability Matrix anchors — each dimension ≥ 1 hit
// ─────────────────────────────────────────────────────────────────────────

test('Meta-rule: 4-dimension matrix has "Detection surface" anchor', () => {
  const content = readRuleContent();
  assert.ok(
    content.includes('Detection surface'),
    'must contain "Detection surface" dimension anchor'
  );
});

test('Meta-rule: 4-dimension matrix has "False positive risk" anchor', () => {
  const content = readRuleContent();
  assert.ok(
    content.includes('False positive risk'),
    'must contain "False positive risk" dimension anchor'
  );
});

test('Meta-rule: 4-dimension matrix has "Mechanical anchor" anchor', () => {
  const content = readRuleContent();
  assert.ok(
    content.includes('Mechanical anchor'),
    'must contain "Mechanical anchor" dimension anchor'
  );
});

test('Meta-rule: 4-dimension matrix has "Enforcement strength" anchor', () => {
  const content = readRuleContent();
  assert.ok(
    content.includes('Enforcement strength'),
    'must contain "Enforcement strength" dimension anchor'
  );
});

test('Meta-rule: hook gates default to pass unless risk is confirmed', () => {
  const content = readRuleContent();
  for (const phrase of [
    '### Hook Gate Default-Pass',
    '事故預防型 hook 預設放行',
    '正向確認具體 workflow / safety / compliance 違規',
    'false-positive 風險高',
    'non-blocking `additionalContext` advisory',
  ]) {
    assert.ok(content.includes(phrase), `must contain default-pass hook principle phrase: ${phrase}`);
  }
});

test('Meta-rule: modifying a mechanical gate requires sweeping its same-family twin gate(s) (in rule-audit-playbook.md)', () => {
  const content = readAuditContent();
  for (const phrase of [
    '### Twin-Gate Sweep',
    'mechanical gate',
    '結構孿生',
    '同一 change 或明確記錄的 follow-up',
    '盤點結論',
    '勿假設「mirror 既有 gate」就對',
  ]) {
    assert.ok(content.includes(phrase), `must contain twin-gate-sweep guideline phrase: ${phrase}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Test 3: ## Periodic Rationalization Cadence heading exists (in audit leaf)
// Moved from rule-design-principles.md → rule-audit-playbook.md by
// enforce-rationalization-loadpath (LM-3 fix: design vs audit time separation).
// ─────────────────────────────────────────────────────────────────────────

test('Meta-rule: rule-audit-playbook.md contains Periodic Rationalization Cadence heading', () => {
  const content = readAuditContent();
  assert.ok(
    content.includes('Cadence'),
    'rule-audit-playbook.md must contain "Cadence" section (Periodic Rationalization Cadence)'
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Test 4: 4 trigger condition anchors (now in rule-audit-playbook.md)
// Cadence content moved from rule-design-principles.md → rule-audit-playbook.md
// by enforce-rationalization-loadpath.
// ─────────────────────────────────────────────────────────────────────────

test('Meta-rule: Cadence contains "5 個 chore B" trigger (in rule-audit-playbook.md)', () => {
  const content = readAuditContent();
  // The rule uses "5 個 chore B" or numeric 5 with chore B context
  assert.ok(
    content.includes('5 個 chore B'),
    'rule-audit-playbook.md must contain "5 個 chore B" trigger condition'
  );
});

test('Meta-rule: Cadence contains "5 個 minor bump" trigger (in rule-audit-playbook.md)', () => {
  const content = readAuditContent();
  assert.ok(
    content.includes('5 個 minor bump'),
    'rule-audit-playbook.md must contain "5 個 minor bump" trigger condition'
  );
});

test('Meta-rule: Cadence contains "6300" byte cap anchor (in rule-audit-playbook.md)', () => {
  const content = readAuditContent();
  assert.ok(
    content.includes('6300'),
    'rule-audit-playbook.md must contain "6300" (AGENTS.md byte count warning threshold = SOFT 6500 − 200 buffer)'
  );
});

test('Meta-rule: Cadence contains "75%" utilization anchor (in rule-audit-playbook.md)', () => {
  const content = readAuditContent();
  assert.ok(
    content.includes('75%'),
    'rule-audit-playbook.md must contain "75%" (leaf rule token cap utilization warning)'
  );
});

test('Meta-rule: cadence signals start an audit and do not preselect a change', () => {
  const cadence = auditCadenceSection();
  for (const phrase of [
    '何時開審，不是何時開 change',
    'audit checkpoint',
    '不得預先建立或選定 B-mini',
  ]) {
    assert.ok(cadence.includes(phrase), `cadence must contain audit/change separation anchor: ${phrase}`);
  }
  assert.ok(
    !cadence.includes('任一達成 → 開 chore B-mini'),
    'cadence must not map a signal directly to B-mini creation'
  );
});

test('Meta-rule: cadence defines dry no-op and disposition-aware static re-arm', () => {
  const cadence = auditCadenceSection();
  for (const phrase of [
    'Audit outcome 與 static signal re-arm',
    'dry audit',
    '不得建立空 change/PR',
    '重複 reminder 不是 audit 未完成',
    '相關內容與 CAP 都未變',
    '跨越下一個適用的 warning / failure boundary',
  ]) {
    assert.ok(cadence.includes(phrase), `cadence must contain dry/re-arm anchor: ${phrase}`);
  }
});

test('Meta-rule: accepted findings route by capability semantics and risk', () => {
  const cadence = auditCadenceSection();
  for (const phrase of [
    '只有 accepted finding 才建立 change',
    'chore A',
    'B-mini',
    'full chore B',
  ]) {
    assert.ok(cadence.includes(phrase), `cadence must contain finding-routing anchor: ${phrase}`);
  }
});

test('Meta-rule: archive cadence warning requests an audit without ordering an empty B-mini', () => {
  const gate = readArchiveGateContent();
  assert.ok(gate.includes('請安排 rule corpus audit'), 'gate warning must request a rule corpus audit');
  assert.ok(gate.includes('dry audit 不建立空 change/PR'), 'gate warning must preserve dry no-op behavior');
  assert.ok(
    !gate.includes('建議下次 PR 開 chore B-mini'),
    'gate warning must not instruct the next PR to create a B-mini'
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Test 5: 4-task rationalization scope anchors (now in rule-audit-playbook.md)
// Scope content moved from rule-design-principles.md → rule-audit-playbook.md
// by enforce-rationalization-loadpath (audit execution belongs to audit leaf).
// ─────────────────────────────────────────────────────────────────────────

test('Meta-rule: Rationalization Scope contains "SSOT dedup" task (in rule-audit-playbook.md)', () => {
  const content = readAuditContent();
  assert.ok(
    content.includes('SSOT dedup'),
    'rule-audit-playbook.md must contain "SSOT dedup" rationalization task'
  );
});

test('Meta-rule: Rationalization Scope contains "Orphan resolution" task (in rule-audit-playbook.md)', () => {
  const content = readAuditContent();
  assert.ok(
    content.includes('Orphan resolution'),
    'rule-audit-playbook.md must contain "Orphan resolution" rationalization task'
  );
});

test('Meta-rule: Rationalization Scope contains "Hook-or-Don\'t-Add audit" task (in rule-audit-playbook.md)', () => {
  const content = readAuditContent();
  assert.ok(
    content.includes('Hook-or-Don\'t-Add audit'),
    'rule-audit-playbook.md must contain "Hook-or-Don\'t-Add audit" rationalization task'
  );
});

test('Meta-rule: Rationalization Scope contains "Dead reference cleanup" task (in rule-audit-playbook.md)', () => {
  const content = readAuditContent();
  assert.ok(
    content.includes('Dead reference cleanup'),
    'rule-audit-playbook.md must contain "Dead reference cleanup" rationalization task'
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Extra: file must not contain FORBIDDEN regex literals (anti-dogfood check)
// Patterns constructed via RegExp constructor per Bundle B+C.
// ─────────────────────────────────────────────────────────────────────────

test('Meta-rule: rule-design-principles.md Canonical FORBIDDEN Regex Set section exists', () => {
  const content = readRuleContent();
  // The file should document the FORBIDDEN regex set (it is the SSOT)
  assert.ok(
    content.includes('Canonical FORBIDDEN Regex Set'),
    'must contain "Canonical FORBIDDEN Regex Set" section'
  );
});
