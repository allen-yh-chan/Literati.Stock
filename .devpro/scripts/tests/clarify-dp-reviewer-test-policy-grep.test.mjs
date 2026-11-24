/**
 * Dual-polarity grep: primary dp-reviewer test-execution policy
 * (clarify-dp-reviewer-test-policy / session-pending #38)
 */
import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { repoPath } from './lib/repo-root.mjs';

const read = (rel) => readFileSync(repoPath(rel), 'utf8');

const CHECKLIST = read('.devpro/agent-rules/code-review-checklist.md');
const EVIDENCE = read('.devpro/agent-rules/pr-review-evidence-verification.md');
const CLAUDE = read('.claude/agents/dp-reviewer.md');
const CURSOR = read('.cursor/agents/dp-reviewer.md');
const CODEX = read('.codex/agents/dp-reviewer.toml');
const OPENCODE = read('.opencode/agent/dp-reviewer.md');

describe('clarify-dp-reviewer-test-policy: positive anchors', () => {
  test('SSOT section exists in code-review-checklist', () => {
    assert.match(
      CHECKLIST,
      /^### Primary Reviewer 測試執行政策$/m,
      'code-review-checklist.md missing §Primary Reviewer 測試執行政策',
    );
    assert.match(
      CHECKLIST,
      /禁止自主執行測試套件／build|禁止自主執行測試套件 \/ build/,
      'SSOT must forbid autonomous test-suite / build execution',
    );
    assert.match(
      CHECKLIST,
      /`--changed main` is not scoped rerun/,
      'SSOT must state --changed main is not scoped rerun',
    );
    assert.match(
      CHECKLIST,
      /不改[\s\S]{0,40}TL pre-PR|--pre-review/,
      'SSOT must preserve TL pre-PR --changed main / --pre-review governance',
    );
  });

  // Scenario title literals for lint-delta-new-scenario-assertion-coverage
  test('Scenario: Default evidence-first without suite re-run', () => {
    assert.match(CHECKLIST, /核對委派 prompt／收據中的 test evidence|核對.*test evidence/);
    assert.match(CLAUDE, /禁止自主執行測試套件 \/ build/);
  });

  test('Scenario: Scoped re-run requires concrete doubt', () => {
    assert.match(CHECKLIST, /具體疑慮/);
    assert.match(CHECKLIST, /窄於整段 change-scoped suite/);
    assert.match(CLAUDE, /具體疑慮時才 scoped/);
  });

  test('Scenario: TL pre-PR suite governance unchanged', () => {
    assert.match(CHECKLIST, /不改[\s\S]{0,80}TL pre-PR/);
    assert.match(
      EVIDENCE,
      /code-review-checklist\.md[^\n]*Primary Reviewer 測試執行政策/,
      'second-reviewer SSOT must pointer primary policy without covering it',
    );
  });

  test('Claude agent prohibition pointers to SSOT', () => {
    const prohibitions = CLAUDE.split('## 禁止事項')[1] || '';
    assert.match(prohibitions, /禁止自主執行測試套件 \/ build/);
    assert.match(prohibitions, /code-review-checklist\.md/);
    assert.match(prohibitions, /Primary Reviewer 測試執行政策/);
    assert.match(prohibitions, /`--changed main` is not scoped rerun/);
  });

  test('Scenario: Primary reviewer scopes integration evidence to this PR', () => {
    assert.match(
      CHECKLIST,
      /PR-stage integration 證據範圍/,
      'code-review-checklist.md missing PR-stage integration evidence scope pointer',
    );
    assert.match(
      CHECKLIST,
      /範圍定義 SSOT：`test-suite-cadence\.md`「PR-stage integration 證據範圍」/,
      'code-review-checklist.md must pointer PR-stage scope definition to test-suite-cadence.md SSOT',
    );
    assert.match(
      CHECKLIST,
      /其他 integration tests[\s\S]{0,120}MUST NOT[\s\S]{0,20}列為 finding/,
      'code-review-checklist.md must state other integration evidence absence MUST NOT be a finding',
    );
    assert.match(
      CHECKLIST,
      /本 PR 新增或修改的 integration tests[\s\S]{0,80}仍須有全綠 primary evidence/,
      'code-review-checklist.md must require green primary evidence for this PR\'s own integration tests',
    );
    assert.match(
      CLAUDE,
      /integration 證據只核對本 PR 增改者/,
      'dp-reviewer.md missing PR-stage integration evidence scope literal',
    );
  });

  test('thin projections carry Role Boundary pointer', () => {
    for (const [name, body] of [
      ['cursor', CURSOR],
      ['codex', CODEX],
      ['opencode', OPENCODE],
    ]) {
      assert.match(
        body,
        /Primary Reviewer 測試執行政策/,
        `${name} dp-reviewer projection missing SSOT pointer`,
      );
      assert.match(
        body,
        /禁止自主跑測試套件/,
        `${name} dp-reviewer projection missing default no-suite duty`,
      );
    }
  });
});

describe('clarify-dp-reviewer-test-policy: negative anchors', () => {
  test('primary agent must not claim default duty to re-run --changed main', () => {
    assert.equal(
      /必須.*(?:重跑|執行).*--changed main/.test(CLAUDE),
      false,
      'dp-reviewer must not require default --changed main re-run',
    );
    assert.equal(
      CLAUDE.includes('預設重跑 full suite'),
      false,
      'dp-reviewer must not say 預設重跑 full suite',
    );
  });

  test('checklist must not collapse second-reviewer and primary surfaces', () => {
    assert.match(
      CHECKLIST,
      /不得互相覆蓋/,
      'SSOT must keep primary vs second-reviewer constraint surfaces distinct',
    );
    assert.equal(
      CHECKLIST.includes('此約束面僅 second-reviewer packet／subprocess，不改 primary／TL'),
      false,
      'checklist must not reuse the second-reviewer-only surface sentence as primary SSOT',
    );
  });
});
