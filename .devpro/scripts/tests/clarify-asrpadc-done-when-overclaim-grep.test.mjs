/**
 * Dual-polarity grep: asrpadc done_when reason: overclaim closure
 * (clarify-asrpadc-done-when-overclaim / F-asrpadc-r1-02)
 * + strengthen-asrpadc-done-when-guards: semantic negative anchors
 * + strengthen-asrpadc-done-when-token-scope: bare reason: + all-proposal section scan
 */
import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { repoPath } from './lib/repo-root.mjs';

const read = (rel) => readFileSync(repoPath(rel), 'utf8');

const ARCHIVE = read(
  'openspec/changes/archive/2026-09-13-add-second-reviewer-preselection-at-dp-change/proposal.md',
);
const OPENSPEC_FLOW = read('openspec/specs/openspec-flow/spec.md');
const CHANGES_ROOT = repoPath('openspec/changes');

/**
 * Output-scope qualifier that must co-occur with reason-only placement claims.
 * Accepts full-width slash, ASCII slash, and 輸出|output wording variants.
 */
const OUTPUT_SCOPE =
  /sticky／audit 輸出語境|sticky\s*／\s*audit|sticky\s*\/\s*audit\s+output|sticky\/audit\s*(輸出|output)/;

/** Backticked or bare reason: token (not part of a longer word). */
const REASON_TOKEN = new RegExp('`reason:`|(?<![\\w`])reason:');

/**
 * Semantic unscoped detector: any clause claiming 只出現於/只寫進 … reason:
 * must also carry an output-scope qualifier in the same clause window.
 * Clause windows split on ；。; and newlines — not on backticks.
 */
export function findUnscopedReasonOnlyClaims(text) {
  const clauses = text.split(/[；。;\n]+/);
  const hits = [];
  for (const clause of clauses) {
    const trimmed = clause.trim();
    if (!trimmed) continue;
    if (!/只(出現於|寫進)/.test(trimmed)) continue;
    if (!REASON_TOKEN.test(trimmed)) continue;
    // Old overclaim framing is always unscoped (ban).
    if (/兩者只出現於/.test(trimmed)) {
      hits.push(trimmed);
      continue;
    }
    if (!OUTPUT_SCOPE.test(trimmed)) {
      hits.push(trimmed);
    }
  }
  return hits;
}

/**
 * Extract Target State + Requirement Ledger bodies from a proposal / proposal-mini.
 * Matches Scenario WHEN surface; avoids meta acceptance lines outside those sections.
 */
export function extractDoneWhenClaimSections(text) {
  const sections = [];
  const patterns = [
    /## Target State\b[\s\S]*?(?=\n## |\n# |\n---\s*$|$)/i,
    /## Requirement Ledger\b[\s\S]*?(?=\n## |\n# |\n---\s*$|$)/i,
    /## Requirement Ledger Completion\b[\s\S]*?(?=\n## |\n# |\n---\s*$|$)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) sections.push(m[0]);
  }
  return sections;
}

function listProposalFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name === 'proposal.md' || ent.name === 'proposal-mini.md') out.push(p);
    }
  };
  walk(root);
  return out;
}

describe('clarify-asrpadc-done-when-overclaim: positive anchors', () => {
  test('Target State 5 scopes reason: claim to sticky/audit output', () => {
    assert.match(
      ARCHIVE,
      /於 sticky／audit 輸出語境中只出現於 `reason:`/,
      'archive Target State 5 must scope reason: claim to sticky/audit output',
    );
    assert.match(
      ARCHIVE,
      /SKILL／spec／ledger 正文可出現同 token/,
      'archive must allow SKILL/spec/ledger narration of the token',
    );
  });

  test('R5 ledger matches output-scoped wording', () => {
    assert.match(
      ARCHIVE,
      /於 sticky／audit 輸出語境中 `user-preselected` 只寫進 `reason:`/,
      'R5 must scope user-preselected to sticky/audit output reason:',
    );
  });

  // Scenario title literals for lint-delta-new-scenario-assertion-coverage
  test('Scenario: Archived asrpadc Target State 5 is scoped to sticky/audit output', () => {
    assert.match(ARCHIVE, /sticky／audit 輸出語境/);
    assert.match(ARCHIVE, /只出現於 `reason:`/);
  });

  test('Scenario: Broad reason-only claim is forbidden for that archive', () => {
    assert.equal(
      ARCHIVE.includes('兩者只出現於 `reason:` 語境'),
      false,
      'old overclaim phrase must be absent',
    );
  });

  test('Scenario: Any done_when reason-only claim requires output-scope qualifier', () => {
    assert.match(
      OPENSPEC_FLOW,
      /#### Scenario: Any done_when reason-only claim requires output-scope qualifier/,
    );
    assert.match(
      OPENSPEC_FLOW,
      /MUST include sticky \/ audit output-scope wording/,
    );
  });

  test('Scenario: Policy narration of reason tokens remains allowed', () => {
    assert.match(
      OPENSPEC_FLOW,
      /#### Scenario: Policy narration of reason tokens remains allowed/,
    );
    assert.match(
      OPENSPEC_FLOW,
      /MUST NOT by itself violate Done-When Sticky Reason Token Scope Honesty/,
    );
  });

  test('Scenario: Bare reason token placement claims are in scope for the detector', () => {
    // Pre-promote: title lives in active/archived delta; post-promote also in canonical.
    const delta = read(
      'openspec/changes/archive/2026-09-21-strengthen-asrpadc-done-when-token-scope/specs/openspec-flow/spec.md',
    );
    assert.match(
      delta,
      /#### Scenario: Bare reason token placement claims are in scope for the detector/,
    );
    assert.match(delta, /bare `reason:` token \(no backticks\)/);
  });

  test('Scenario: Any-proposal section scan enforces the general done_when scenarios', () => {
    const delta = read(
      'openspec/changes/archive/2026-09-21-strengthen-asrpadc-done-when-token-scope/specs/openspec-flow/spec.md',
    );
    assert.match(
      delta,
      /#### Scenario: Any-proposal section scan enforces the general done_when scenarios/,
    );
  });

});

describe('clarify-asrpadc-done-when-overclaim: negative anchors', () => {
  test('must not restore repo-wide reason-only overclaim', () => {
    assert.equal(
      ARCHIVE.includes('兩者只出現於 `reason:` 語境'),
      false,
      'archive must not restore literal 兩者只出現於 `reason:` 語境 overclaim',
    );
  });

  test('reason-only placement claims must carry output-scope in the same clause', () => {
    const unscoped = findUnscopedReasonOnlyClaims(ARCHIVE).filter(
      (c) => !/兩者只出現於/.test(c), // covered by dedicated ban above
    );
    assert.equal(
      unscoped.length,
      0,
      `unscoped reason-only claims (missing sticky／audit 輸出語境 in same clause):\n${unscoped.join('\n---\n')}`,
    );
  });

  test('semantic detector rejects unscoped claim and accepts scoped claim', () => {
    const bad = '標籤語意不變：user-preselected 只寫進 `reason:`（primary 證明）。';
    const good =
      '於 sticky／audit 輸出語境中 `user-preselected` 只寫進 `reason:`（primary 證明）。';
    assert.ok(
      findUnscopedReasonOnlyClaims(bad).length >= 1,
      'detector must flag unscoped 只寫進 reason: claim',
    );
    assert.equal(
      findUnscopedReasonOnlyClaims(good).length,
      0,
      'detector must accept output-scoped 只寫進 reason: claim',
    );
  });

  test('semantic detector rejects bare reason: without backticks', () => {
    const badBare = 'user-preselected 只寫進 reason:（primary 證明）。';
    const goodBare =
      '於 sticky／audit 輸出語境中 user-preselected 只寫進 reason:（primary 證明）。';
    const goodSlash =
      '於 sticky/audit output 中只出現於 reason:';
    assert.ok(
      findUnscopedReasonOnlyClaims(badBare).length >= 1,
      'detector must flag bare unscoped reason: claim',
    );
    assert.equal(
      findUnscopedReasonOnlyClaims(goodBare).length,
      0,
      'detector must accept bare reason: with full-width sticky／audit scope',
    );
    assert.equal(
      findUnscopedReasonOnlyClaims(goodSlash).length,
      0,
      'detector must accept sticky/audit output scope variant',
    );
  });
});

describe('clarify-asrpadc-done-when-overclaim: all-proposal section scan', () => {
  test('Target State / Requirement Ledger sections across all proposals are scoped', () => {
    const files = listProposalFiles(CHANGES_ROOT);
    assert.ok(files.length > 1, 'must scan more than one proposal file');
    const failures = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const sections = extractDoneWhenClaimSections(text);
      if (sections.length === 0) continue;
      for (const section of sections) {
        const hits = findUnscopedReasonOnlyClaims(section).filter(
          (c) => !/兩者只出現於/.test(c),
        );
        if (hits.length) {
          const rel = path.relative(CHANGES_ROOT, file);
          const detail = hits.map((h) => '  - ' + h).join('\n');
          failures.push(rel + ':\n' + detail);
        }
      }
    }
    assert.equal(
      failures.length,
      0,
      `unscoped reason-only claims in Target State / Requirement Ledger:\n${failures.join('\n')}`,
    );
  });

  test('section extractor covers Target State and Requirement Ledger only', () => {
    const sample = [
      '## Why',
      'meta: unscoped 只寫進 reason: should not be scanned',
      '',
      '## Target State',
      '1. 於 sticky／audit 輸出語境中只出現於 reason:',
      '',
      '## Tasks',
      '- 驗收: unscoped 只寫進 reason: → fail',
    ].join('\n');
    const sections = extractDoneWhenClaimSections(sample);
    assert.equal(sections.length, 1);
    assert.equal(findUnscopedReasonOnlyClaims(sections[0]).length, 0);
    // Meta outside Target State must not be in the extracted surface
    assert.ok(!sections[0].includes('## Why'));
    assert.ok(!sections[0].includes('## Tasks'));
  });
});
