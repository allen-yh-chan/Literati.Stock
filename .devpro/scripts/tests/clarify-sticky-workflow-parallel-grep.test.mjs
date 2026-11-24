/**
 * Dual-polarity grep: Step 5 ∥ Step 5.5 parallelism SSOT
 * (clarify-sticky-workflow-parallel / PR #2742 serial idle-stop fix)
 */
import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { repoPath } from './lib/repo-root.mjs';

const read = (rel) => readFileSync(repoPath(rel), 'utf8');

const GATE = read('.devpro/agent-rules/post-pr-completion-gate.md');
const PRE_PR = read('.devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md');
const TRACKING = read('.devpro/agent-rules/git-workflow-tracking.md');
const CHECKLIST = read('.devpro/agent-rules/dev-flow-checklist.md');

describe('clarify-sticky-workflow-parallel: positive anchors', () => {
  test('SSOT section exists in post-pr-completion-gate', () => {
    assert.match(
      GATE,
      /Step 5 ∥ Step 5\.5 Parallelism/,
      'post-pr-completion-gate.md missing §Step 5 ∥ Step 5.5 Parallelism SSOT heading',
    );
    assert.match(
      GATE,
      /MAY／SHOULD 並行啟動|MAY\/SHOULD 並行啟動|並行啟動/,
      'SSOT must state Step 5 and 5.5 may/should start in parallel',
    );
    assert.match(
      GATE,
      /MUST NOT[\s\S]{0,400}sticky[\s\S]{0,200}前置|禁以 CI[\s\S]{0,80}sticky/,
      'SSOT must forbid CI/workflow terminal as sticky precondition',
    );
    assert.match(
      GATE,
      /checks-based/,
      'SSOT must require checks-based sticky N/A',
    );
    assert.match(
      GATE,
      /pending/,
      'SSOT must require sticky CI field stay pending before terminal',
    );
  });

  // Scenario title literals for lint-delta-new-scenario-assertion-coverage
  test('Scenario: Sticky PASS while CI still running', () => {
    assert.match(GATE, /並行啟動/);
    assert.match(GATE, /MUST NOT[\s\S]{0,200}sticky[\s\S]{0,120}前置/);
  });

  test('Scenario: Forbidden serial idle-stop', () => {
    assert.equal(PRE_PR.includes('workflow watch 完成）之後'), false);
    assert.match(GATE, /idle-stop|禁[\s\S]{0,40}等 CI|MUST NOT[\s\S]{0,200}idle/);
  });

  test('Scenario: Path-filter miss is not sticky N/A', () => {
    assert.match(GATE, /path-filter miss[\s\S]{0,40}sticky N\/A/);
    assert.match(GATE, /checks-based/);
    assert.match(GATE, /sticky N\/A 僅走既有 checks-based/);
  });

  test('pointer carriers cite SSOT and use parallel wording', () => {
    assert.match(
      PRE_PR,
      /post-pr-completion-gate\.md[^\n]*Step 5 ∥ Step 5\.5 Parallelism/,
      'devpro:pre-pr Step 5.5 must pointer to SSOT Parallelism section',
    );
    assert.match(
      PRE_PR,
      /與 Step 5（workflow watch）\*\*並行\*\*啟動/,
      'devpro:pre-pr Step 5.5 position must say parallel with Step 5',
    );
    assert.match(
      TRACKING,
      /workflow watch ∥ Step 5\.5 exemption check/,
      'git-workflow-tracking must use ∥ parallel hot path',
    );
    assert.match(
      TRACKING,
      /post-pr-completion-gate\.md[^\n]*Step 5 ∥ Step 5\.5 Parallelism/,
      'git-workflow-tracking must pointer to SSOT',
    );
    assert.match(
      CHECKLIST,
      /Step 5 workflow watch ∥ Step 5\.5 exemption check/,
      'dev-flow-checklist Stage 5 must use ∥ parallel wording',
    );
    assert.match(
      CHECKLIST,
      /post-pr-completion-gate\.md[^\n]*Step 5 ∥ Step 5\.5 Parallelism/,
      'dev-flow-checklist must pointer to SSOT',
    );
  });
});

describe('clarify-sticky-workflow-parallel: negative anchors (serial residue forbidden)', () => {
  test('devpro:pre-pr must not say Step 5.5 after workflow watch completes', () => {
    assert.equal(
      PRE_PR.includes('workflow watch 完成）之後'),
      false,
      'devpro:pre-pr must not retain「workflow watch 完成）之後」serial wording',
    );
    assert.equal(
      /位置[^\n]*workflow watch 完成/.test(PRE_PR),
      false,
      'devpro:pre-pr Step 5.5 位置 must not bind to workflow watch 完成',
    );
  });

  test('tracking must not serialize sticky behind workflow terminal', () => {
    assert.equal(
      TRACKING.includes('workflow 終態後 → Step 5.5'),
      false,
      'git-workflow-tracking must not say「workflow 終態後 → Step 5.5」',
    );
    assert.equal(
      TRACKING.includes('workflow watch → Step 5.5 exemption check'),
      false,
      'git-workflow-tracking must not retain arrow-serial「workflow watch → Step 5.5」',
    );
  });

  test('checklist must not use arrow-serial Step 5 → Step 5.5', () => {
    assert.equal(
      CHECKLIST.includes('Step 5 workflow watch（handoff') &&
        CHECKLIST.includes('）→ Step 5.5 exemption check'),
      false,
      'dev-flow-checklist must not retain serial Step 5 → Step 5.5 handoff chain',
    );
  });
});
