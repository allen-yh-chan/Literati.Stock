import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  lintDeltaBodyCanonicalWrap,
  normalizeGitRelativePath,
} from '../lint-delta-body-canonical-wrap.mjs';
import { SOURCE_ROOT } from './lib/repo-root.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'lint-delta-body-canonical-wrap.mjs');
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function toCrlf(text) {
  return text.replace(/\n/g, '\r\n');
}

/**
 * Build a fixture tree under a tmp dir.
 *
 * Layout:
 *   <root>/
 *     openspec/
 *       changes/<changeName>/
 *         specs/<cap>/spec.md    (delta)
 *       specs/<cap>/spec.md      (canonical, optional)
 *
 * Returns { root, changeFolder } for use with lintDeltaBodyCanonicalWrap.
 */
function buildFixture({
  changeName = 'test-change',
  cap = 'test-cap',
  deltaContent,
  canonicalContent,
}) {
  const root = join(tmpdir(), `lint-wrap-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const changeFolder = join(root, 'openspec', 'changes', changeName);
  const deltaSpecDir = join(changeFolder, 'specs', cap);

  mkdirSync(deltaSpecDir, { recursive: true });

  if (deltaContent !== undefined) {
    writeFileSync(join(deltaSpecDir, 'spec.md'), deltaContent, 'utf8');
  }
  if (canonicalContent !== undefined) {
    const canonicalSpecDir = join(root, 'openspec', 'specs', cap);
    mkdirSync(canonicalSpecDir, { recursive: true });
    writeFileSync(join(canonicalSpecDir, 'spec.md'), canonicalContent, 'utf8');
  }

  return { root, changeFolder };
}

function commitFixtureBaseline(root) {
  for (const args of [
    ['init'],
    ['config', 'user.email', 'lint-fixture@example.invalid'],
    ['config', 'user.name', 'Lint Fixture'],
    ['add', '.'],
    ['commit', '-m', 'baseline'],
  ]) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(
      result.status,
      0,
      `git ${args.join(' ')} failed: stdout=${result.stdout}; stderr=${result.stderr}`,
    );
  }
}

// --- Canonical with single-line requirement body ---
const CANONICAL_SINGLE_LINE_BODY = `# test-cap Specification

## Requirements

### Requirement: Widget Processing

The system SHALL process widgets efficiently with the advanced algorithm that ensures correctness.

#### Scenario: Happy Path
- **WHEN** a valid widget is submitted
- **THEN** the system SHALL accept it and return 200

`;

// --- Delta with hard-wrapped (multi-line) requirement body ---
const DELTA_HARD_WRAPPED = `# test-cap Spec Delta

## MODIFIED Requirements

### Requirement: Widget Processing

The system SHALL process widgets efficiently
with the advanced algorithm that ensures correctness.

#### Scenario: Happy Path
- **WHEN** a valid widget is submitted
- **THEN** the system SHALL accept it and return 200

`;

// --- Delta with same single-line body as canonical ---
const DELTA_SINGLE_LINE_MATCHING = `# test-cap Spec Delta

## MODIFIED Requirements

### Requirement: Widget Processing

The system SHALL process widgets efficiently with the advanced algorithm that ensures correctness.

#### Scenario: Happy Path
- **WHEN** a valid widget is submitted
- **THEN** the system SHALL accept it and return 200

`;

// --- Canonical with multi-line requirement body ---
const CANONICAL_MULTI_LINE_BODY = `# test-cap Specification

## Requirements

### Requirement: Multi Line Widget

The system SHALL process widgets
using the multi-line approach
as documented.

#### Scenario: Happy Path
- **WHEN** a valid widget is submitted
- **THEN** the system SHALL accept it

`;

// --- Delta matching canonical multi-line body ---
const DELTA_MULTI_LINE_MATCHING = `# test-cap Spec Delta

## MODIFIED Requirements

### Requirement: Multi Line Widget

The system SHALL process widgets
using the multi-line approach
as documented.

#### Scenario: Happy Path
- **WHEN** a valid widget is submitted
- **THEN** the system SHALL accept it

`;

const CANONICAL_SEPARATOR_MULTI_REQUIREMENT = `# test-cap Specification

## Requirements

### Requirement: Separator Protected

The system SHALL preserve the canonical main body.

#### Scenario: Existing behavior
- **WHEN** the canonical behavior runs
- **THEN** the system SHALL preserve the canonical scenario body

---

### Requirement: Final Control

The system SHALL preserve the final requirement through EOF.

#### Scenario: Final behavior
- **WHEN** the final behavior runs
- **THEN** the system SHALL preserve the final scenario body

`;

const DELTA_SEPARATOR_MATCHING = `# test-cap Spec Delta

## MODIFIED Requirements

### Requirement: Separator Protected

The system SHALL preserve the canonical main body.

#### Scenario: Existing behavior
- **WHEN** the canonical behavior runs
- **THEN** the system SHALL preserve the canonical scenario body

`;

describe('lint-delta-body-canonical-wrap', () => {
  // Case 1: delta MODIFIED body hard-wrapped while canonical is single-line → violation
  test('Case 1: delta MODIFIED body hard-wrap while canonical single-line → violation', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: DELTA_HARD_WRAPPED,
      canonicalContent: CANONICAL_SINGLE_LINE_BODY,
    });
    try {
      const result = lintDeltaBodyCanonicalWrap({ changeFolder, repoRoot: root });
      assert.equal(result.pass, false, 'expected pass:false when delta body is hard-wrapped');
      assert.equal(result.violations.length, 1);
      const v = result.violations[0];
      assert.equal(v.cap, 'test-cap');
      assert.equal(v.requirement, 'Widget Processing');
      assert.ok(v.firstDiff !== null, 'firstDiff should be set');
      assert.equal(v.firstDiff.index, 0, 'first diff at line index 0');
      // delta line 0 is the first partial line
      assert.match(v.firstDiff.delta, /process widgets efficiently$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Case 1b: CRLF delta MODIFIED body hard-wrap while canonical single-line → violation', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: toCrlf(DELTA_HARD_WRAPPED),
      canonicalContent: CANONICAL_SINGLE_LINE_BODY,
    });
    try {
      const result = lintDeltaBodyCanonicalWrap({ changeFolder, repoRoot: root });
      assert.equal(result.pass, false, 'expected pass:false when CRLF delta body is hard-wrapped');
      assert.equal(result.violations.length, 1);
      const v = result.violations[0];
      assert.equal(v.cap, 'test-cap');
      assert.equal(v.requirement, 'Widget Processing');
      assert.ok(v.firstDiff !== null, 'firstDiff should be set');
      assert.equal(v.firstDiff.index, 0, 'first diff at line index 0');
      assert.match(v.firstDiff.delta, /process widgets efficiently$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Case 2: delta MODIFIED body matches canonical single-line → pass
  test('Case 2: delta MODIFIED body matches canonical → pass', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: DELTA_SINGLE_LINE_MATCHING,
      canonicalContent: CANONICAL_SINGLE_LINE_BODY,
    });
    try {
      const result = lintDeltaBodyCanonicalWrap({ changeFolder, repoRoot: root });
      assert.equal(result.pass, true, `unexpected violations: ${JSON.stringify(result.violations)}`);
      assert.equal(result.violations.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Case 2a: LF separator-delimited canonical requirement matches delta → pass', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: DELTA_SEPARATOR_MATCHING,
      canonicalContent: CANONICAL_SEPARATOR_MULTI_REQUIREMENT,
    });
    try {
      const result = lintDeltaBodyCanonicalWrap({ changeFolder, repoRoot: root });
      assert.equal(result.pass, true, `unexpected violations: ${JSON.stringify(result.violations)}`);
      assert.equal(result.violations.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Case 2b: CRLF separator-delimited canonical requirement matches delta → pass', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: toCrlf(DELTA_SEPARATOR_MATCHING),
      canonicalContent: toCrlf(CANONICAL_SEPARATOR_MULTI_REQUIREMENT),
    });
    try {
      const result = lintDeltaBodyCanonicalWrap({ changeFolder, repoRoot: root });
      assert.equal(result.pass, true, `unexpected violations: ${JSON.stringify(result.violations)}`);
      assert.equal(result.violations.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Case 2c: separator-delimited canonical main-body drift remains a violation', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: DELTA_SEPARATOR_MATCHING.replace(
        'The system SHALL preserve the canonical main body.',
        'The system SHALL preserve a drifted main body.',
      ),
      canonicalContent: CANONICAL_SEPARATOR_MULTI_REQUIREMENT,
    });
    try {
      const result = lintDeltaBodyCanonicalWrap({ changeFolder, repoRoot: root });
      assert.equal(result.pass, false, 'expected pass:false for real main-body drift');
      assert.equal(result.violations.length, 1);
      assert.equal(result.violations[0].kind, 'body-line-structure-drift');
      assert.equal(result.violations[0].requirement, 'Separator Protected');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Case 2d: separator-delimited canonical scenario drift remains a violation', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: toCrlf(
        DELTA_SEPARATOR_MATCHING.replace(
          'the system SHALL preserve the canonical scenario body',
          'the system SHALL preserve a drifted scenario body',
        ),
      ),
      canonicalContent: toCrlf(CANONICAL_SEPARATOR_MULTI_REQUIREMENT),
    });
    try {
      const result = lintDeltaBodyCanonicalWrap({ changeFolder, repoRoot: root });
      assert.equal(result.pass, false, 'expected pass:false for real scenario drift');
      assert.equal(result.violations.length, 1);
      assert.equal(result.violations[0].kind, 'body-line-structure-drift');
      assert.equal(result.violations[0].requirement, 'Separator Protected');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Case 3: canonical is multi-line AND delta matches canonical multi-line → pass
  // (Ensures we don't false-positive when canonical itself is multi-line)
  test('Case 3: canonical multi-line, delta matches canonical multi-line → pass (no false positive)', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: DELTA_MULTI_LINE_MATCHING,
      canonicalContent: CANONICAL_MULTI_LINE_BODY,
      cap: 'test-cap',
    });
    try {
      const result = lintDeltaBodyCanonicalWrap({ changeFolder, repoRoot: root });
      assert.equal(result.pass, true, `unexpected violations: ${JSON.stringify(result.violations)}`);
      assert.equal(result.violations.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Case 4: new capability (no canonical spec) → skip → pass
  test('Case 4: new capability without canonical spec → skip → pass', () => {
    const root = join(tmpdir(), `lint-wrap-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const changeName = 'test-change';
    const cap = 'brand-new-capability';
    const changeFolder = join(root, 'openspec', 'changes', changeName);
    const deltaSpecDir = join(changeFolder, 'specs', cap);
    mkdirSync(deltaSpecDir, { recursive: true });
    writeFileSync(join(deltaSpecDir, 'spec.md'), DELTA_HARD_WRAPPED, 'utf8');
    // No canonical created for this cap
    try {
      const result = lintDeltaBodyCanonicalWrap({ changeFolder, repoRoot: root });
      assert.equal(result.pass, true, `unexpected violations: ${JSON.stringify(result.violations)}`);
      assert.equal(result.violations.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Case 5: delta has only ADDED block (no MODIFIED block) → pass
  test('Case 5: delta with only ADDED Requirements (no MODIFIED block) → pass', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: `# test-cap Spec Delta

## ADDED Requirements

### Requirement: Brand New Feature

The system SHALL support brand new features
across multiple lines.

#### Scenario: Happy Path
- **WHEN** a new request arrives
- **THEN** the system SHALL handle it

`,
      canonicalContent: CANONICAL_SINGLE_LINE_BODY,
    });
    try {
      const result = lintDeltaBodyCanonicalWrap({ changeFolder, repoRoot: root });
      assert.equal(result.pass, true, `unexpected violations: ${JSON.stringify(result.violations)}`);
      assert.equal(result.violations.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Case 6: no specs/ directory → pass
  test('Case 6: no specs directory in change folder → pass', () => {
    const root = join(tmpdir(), `lint-wrap-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const changeFolder = join(root, 'openspec', 'changes', 'test-change');
    mkdirSync(changeFolder, { recursive: true });
    // No specs/ subdirectory
    try {
      const result = lintDeltaBodyCanonicalWrap({ changeFolder, repoRoot: root });
      assert.equal(result.pass, true, `unexpected violations: ${JSON.stringify(result.violations)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Case 7: delta MODIFIED has requirement name not in canonical → skip → pass
  test('Case 7: delta MODIFIED requirement name not in canonical → skip → pass', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: `# test-cap Spec Delta

## MODIFIED Requirements

### Requirement: Completely Different Requirement

The system SHALL do something
completely unrelated.

#### Scenario: Only Scenario
- **WHEN** something
- **THEN** the system SHALL respond

`,
      canonicalContent: CANONICAL_SINGLE_LINE_BODY,
    });
    try {
      const result = lintDeltaBodyCanonicalWrap({ changeFolder, repoRoot: root });
      assert.equal(result.pass, true, `unexpected violations: ${JSON.stringify(result.violations)}`);
      assert.equal(result.violations.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Case 8: trailing whitespace differences are ignored by normalize
  test('Case 8: trailing whitespace differences in delta body are normalized away → pass', () => {
    const { root, changeFolder } = buildFixture({
      // Delta body has trailing spaces on lines
      deltaContent: `# test-cap Spec Delta\n\n## MODIFIED Requirements\n\n### Requirement: Widget Processing\n\nThe system SHALL process widgets efficiently with the advanced algorithm that ensures correctness.   \n\n#### Scenario: Happy Path\n- **WHEN** a valid widget is submitted  \n- **THEN** the system SHALL accept it and return 200\n\n`,
      canonicalContent: CANONICAL_SINGLE_LINE_BODY,
    });
    try {
      const result = lintDeltaBodyCanonicalWrap({ changeFolder, repoRoot: root });
      assert.equal(result.pass, true, `unexpected violations: ${JSON.stringify(result.violations)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Case 9: canonical multi-line, delta has SAME TEXT but DIFFERENT line-breaks → violation
  // (The subtlest real risk: the words are identical but re-wrapped, so a grep-asserted
  //  phrase spanning a different boundary breaks on promote. Must be caught even when
  //  canonical is itself multi-line — this is what Case 3 does NOT cover.)
  test('Case 9: canonical multi-line, delta same words but different wrap boundary → violation', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: `# test-cap Spec Delta

## MODIFIED Requirements

### Requirement: Multi Line Widget

The system SHALL process widgets using
the multi-line approach as documented.

#### Scenario: Happy Path
- **WHEN** a valid widget is submitted
- **THEN** the system SHALL accept it

`,
      canonicalContent: CANONICAL_MULTI_LINE_BODY,
    });
    try {
      const result = lintDeltaBodyCanonicalWrap({ changeFolder, repoRoot: root });
      assert.equal(result.pass, false, 'expected violation: same words but different wrap boundary breaks grep phrases on promote');
      assert.equal(result.violations.length, 1);
      assert.equal(result.violations[0].requirement, 'Multi Line Widget');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Case 10: hard-wrap inside a SCENARIO body (not the main section) → violation
  // (blockLinesOf covers sub-section bodies; a wrapped THEN clause must be caught too.)
  test('Case 10: hard-wrap inside scenario body (not main section) → violation', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: `# test-cap Spec Delta

## MODIFIED Requirements

### Requirement: Widget Processing

The system SHALL process widgets efficiently with the advanced algorithm that ensures correctness.

#### Scenario: Happy Path
- **WHEN** a valid widget is submitted
- **THEN** the system SHALL accept it
  and return 200

`,
      canonicalContent: CANONICAL_SINGLE_LINE_BODY,
    });
    try {
      const result = lintDeltaBodyCanonicalWrap({ changeFolder, repoRoot: root });
      assert.equal(result.pass, false, 'expected violation: scenario-body hard-wrap must be caught (blockLinesOf includes sub-section bodies)');
      assert.equal(result.violations.length, 1);
      assert.equal(result.violations[0].requirement, 'Widget Processing');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Case 11: delta MODIFIED adds a complete NEW scenario segment to an existing
  // requirement, while every existing canonical segment (main section + existing
  // scenario) is preserved contiguously and in original order → pass.
  // This is the legal "MODIFIED adds scenario" authoring pattern that canonical
  // openspec-flow Spec Delta Authoring Discipline scenario 1 explicitly allows,
  // but the old Math.max equal-length comparison flags as drift because the
  // extra scenario's lines have no canonical counterpart at the same index.
  test('Case 11: delta MODIFIED adds a complete new scenario segment to existing requirement → pass', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: `# test-cap Spec Delta

## MODIFIED Requirements

### Requirement: Widget Processing

The system SHALL process widgets efficiently with the advanced algorithm that ensures correctness.

#### Scenario: Happy Path
- **WHEN** a valid widget is submitted
- **THEN** the system SHALL accept it and return 200

#### Scenario: Rejected Path
- **WHEN** an invalid widget is submitted
- **THEN** the system SHALL reject it and return 400

`,
      canonicalContent: CANONICAL_SINGLE_LINE_BODY,
    });
    try {
      const result = lintDeltaBodyCanonicalWrap({ changeFolder, repoRoot: root });
      assert.equal(result.pass, true, `unexpected violations: ${JSON.stringify(result.violations)}`);
      assert.equal(result.violations.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Case 12: delta MODIFIED drops one body line from an existing canonical
  // scenario (not a whole scenario, just a line within it) → violation.
  // Contiguous-block-anchored comparison must still catch a missing line inside
  // a segment, not just whole-segment omission.
  test('Case 12: delta MODIFIED drops a canonical scenario body line → violation', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: `# test-cap Spec Delta

## MODIFIED Requirements

### Requirement: Widget Processing

The system SHALL process widgets efficiently with the advanced algorithm that ensures correctness.

#### Scenario: Happy Path
- **WHEN** a valid widget is submitted

`,
      canonicalContent: CANONICAL_SINGLE_LINE_BODY,
    });
    try {
      const result = lintDeltaBodyCanonicalWrap({ changeFolder, repoRoot: root });
      assert.equal(result.pass, false, 'expected violation: dropped canonical scenario body line must be caught');
      assert.equal(result.violations.length, 1);
      assert.equal(result.violations[0].requirement, 'Widget Processing');
      assert.ok(result.violations[0].firstDiff !== null, 'firstDiff should be set');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Case 13: base-aware lint rejects a canonical requirement touched outside the delta', () => {
    const baselineCanonical = `${CANONICAL_SINGLE_LINE_BODY}
### Requirement: Callback Waiting

The runtime SHALL poll while waiting.

#### Scenario: Waiting
- **WHEN** work is delegated
- **THEN** the runtime SHALL poll every minute

`;
    const currentCanonical = baselineCanonical
      .replace('The runtime SHALL poll while waiting.', 'The runtime SHALL wait for a completion callback when available.')
      .replace('the runtime SHALL poll every minute', 'the runtime SHALL NOT poll when a callback is available');
    const { root, changeFolder } = buildFixture({
      deltaContent: DELTA_SINGLE_LINE_MATCHING,
      canonicalContent: baselineCanonical,
    });
    try {
      commitFixtureBaseline(root);
      writeFileSync(join(root, 'openspec', 'specs', 'test-cap', 'spec.md'), currentCanonical, 'utf8');

      const result = lintDeltaBodyCanonicalWrap({ changeFolder, repoRoot: root, baseRef: 'HEAD' });
      assert.equal(result.pass, false, 'a touched canonical requirement absent from the delta must fail closed');
      assert.deepEqual(
        result.violations.map(v => [v.kind, v.cap, v.requirement]),
        [['canonical-touch-missing-delta', 'test-cap', 'Callback Waiting']],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Case 14: base-aware lint passes when every touched canonical requirement is mirrored', () => {
    const baselineCanonical = `${CANONICAL_SINGLE_LINE_BODY}
### Requirement: Callback Waiting

The runtime SHALL poll while waiting.

#### Scenario: Waiting
- **WHEN** work is delegated
- **THEN** the runtime SHALL poll every minute

`;
    const currentCanonical = baselineCanonical
      .replace('The runtime SHALL poll while waiting.', 'The runtime SHALL wait for a completion callback when available.')
      .replace('the runtime SHALL poll every minute', 'the runtime SHALL NOT poll when a callback is available');
    const deltaWithBothRequirements = `${DELTA_SINGLE_LINE_MATCHING}
### Requirement: Callback Waiting

The runtime SHALL wait for a completion callback when available.

#### Scenario: Waiting
- **WHEN** work is delegated
- **THEN** the runtime SHALL NOT poll when a callback is available

`;
    const { root, changeFolder } = buildFixture({
      deltaContent: deltaWithBothRequirements,
      canonicalContent: baselineCanonical,
    });
    try {
      commitFixtureBaseline(root);
      writeFileSync(join(root, 'openspec', 'specs', 'test-cap', 'spec.md'), currentCanonical, 'utf8');

      const result = lintDeltaBodyCanonicalWrap({ changeFolder, repoRoot: root, baseRef: 'HEAD' });
      assert.equal(result.pass, true, `unexpected violations: ${JSON.stringify(result.violations)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Case 15: appending a requirement does not mark its predecessor as touched', () => {
    const addedRequirement = `### Requirement: Callback Waiting

The runtime SHALL wait for a completion callback when available.

#### Scenario: Waiting
- **WHEN** work is delegated
- **THEN** the runtime SHALL NOT poll when a callback is available

`;
    const deltaWithAddedRequirement = `# test-cap Spec Delta

## ADDED Requirements

${addedRequirement}`;
    const { root, changeFolder } = buildFixture({
      deltaContent: DELTA_SINGLE_LINE_MATCHING,
      canonicalContent: CANONICAL_SINGLE_LINE_BODY,
    });
    try {
      commitFixtureBaseline(root);
      writeFileSync(
        join(root, 'openspec', 'specs', 'test-cap', 'spec.md'),
        `${CANONICAL_SINGLE_LINE_BODY}${addedRequirement}`,
        'utf8',
      );
      writeFileSync(join(changeFolder, 'specs', 'test-cap', 'spec.md'), deltaWithAddedRequirement, 'utf8');

      const result = lintDeltaBodyCanonicalWrap({ changeFolder, repoRoot: root, baseRef: 'HEAD' });
      assert.equal(result.pass, true, `unexpected violations: ${JSON.stringify(result.violations)}`);
      assert.equal(result.violations.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Case 15a: source documents the closed Requirement-attribution boundary', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    assert.match(
      source,
      /DESIGN INVARIANT: Requirement attribution is intentionally closed-world:[\s\S]*preamble, `## Purpose`, and separating blank lines remain outside every Requirement span[\s\S]*MUST NOT attribute their diffs to the nearest Requirement/,
    );
  });

  test('Case 15b: preamble, Purpose, and separator-only diffs do not touch a Requirement', async t => {
    const baselineCanonical = `Preamble baseline.

# test-cap Specification

## Purpose

Baseline purpose.

## Requirements

### Requirement: First Coverage

The system SHALL preserve first coverage.

#### Scenario: First
- **WHEN** the first path runs
- **THEN** first coverage SHALL remain

### Requirement: Second Coverage

The system SHALL preserve second coverage.

#### Scenario: Second
- **WHEN** the second path runs
- **THEN** second coverage SHALL remain

`;
    const deltaWithoutRequirements = `# test-cap Spec Delta

## ADDED Requirements

`;
    const cases = [
      {
        name: 'preamble text',
        mutate: content => content.replace('Preamble baseline.', 'Preamble revised.'),
      },
      {
        name: 'Purpose body',
        mutate: content => content.replace('Baseline purpose.', 'Revised purpose.'),
      },
      {
        name: 'separator before the first Requirement',
        mutate: content => content.replace('## Requirements\n\n### Requirement', '## Requirements\n\n\n### Requirement'),
      },
      {
        name: 'separator between Requirements',
        mutate: content => content.replace(
          'first coverage SHALL remain\n\n### Requirement: Second Coverage',
          'first coverage SHALL remain\n\n\n### Requirement: Second Coverage',
        ),
      },
    ];

    for (const { name, mutate } of cases) {
      await t.test(name, () => {
        const { root, changeFolder } = buildFixture({
          deltaContent: deltaWithoutRequirements,
          canonicalContent: baselineCanonical,
        });
        try {
          commitFixtureBaseline(root);
          writeFileSync(
            join(root, 'openspec', 'specs', 'test-cap', 'spec.md'),
            mutate(baselineCanonical),
            'utf8',
          );

          const result = lintDeltaBodyCanonicalWrap({ changeFolder, repoRoot: root, baseRef: 'HEAD' });
          assert.equal(result.pass, true, `${name} was misattributed: ${JSON.stringify(result.violations)}`);
          assert.deepEqual(result.violations, []);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });
    }
  });

  test('Case 16: base-aware lint rejects a touched capability with no delta capability folder', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: DELTA_SINGLE_LINE_MATCHING,
      canonicalContent: CANONICAL_SINGLE_LINE_BODY,
    });
    const missingCap = 'missing-cap';
    const missingCanonicalDir = join(root, 'openspec', 'specs', missingCap);
    try {
      commitFixtureBaseline(root);
      mkdirSync(missingCanonicalDir, { recursive: true });
      writeFileSync(
        join(missingCanonicalDir, 'spec.md'),
        CANONICAL_SINGLE_LINE_BODY.replaceAll('test-cap', missingCap).replace('Widget Processing', 'Missing Delta Coverage'),
        'utf8',
      );
      const add = spawnSync('git', ['add', join('openspec', 'specs', missingCap, 'spec.md')], {
        cwd: root,
        encoding: 'utf8',
      });
      assert.equal(add.status, 0, add.stderr);

      const result = lintDeltaBodyCanonicalWrap({ changeFolder, repoRoot: root, baseRef: 'HEAD' });
      assert.equal(result.pass, false, 'a whole missing delta capability folder must fail closed');
      assert.deepEqual(
        result.violations.map(v => [v.kind, v.cap, v.requirement]),
        [['canonical-touch-missing-delta', missingCap, 'Missing Delta Coverage']],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Case 17: base-aware lint accepts a new canonical capability mirrored by an ADDED delta', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: DELTA_SINGLE_LINE_MATCHING,
      canonicalContent: CANONICAL_SINGLE_LINE_BODY,
    });
    const newCap = 'new-cap';
    const newRequirement = CANONICAL_SINGLE_LINE_BODY
      .replaceAll('test-cap', newCap)
      .replace('Widget Processing', 'New Capability Coverage');
    try {
      commitFixtureBaseline(root);
      mkdirSync(join(root, 'openspec', 'specs', newCap), { recursive: true });
      mkdirSync(join(changeFolder, 'specs', newCap), { recursive: true });
      writeFileSync(join(root, 'openspec', 'specs', newCap, 'spec.md'), newRequirement, 'utf8');
      writeFileSync(
        join(changeFolder, 'specs', newCap, 'spec.md'),
        newRequirement.replace(`# ${newCap} Specification\n\n## Requirements`, `# ${newCap} Spec Delta\n\n## ADDED Requirements`),
        'utf8',
      );
      const add = spawnSync('git', ['add', join('openspec', 'specs', newCap, 'spec.md')], {
        cwd: root,
        encoding: 'utf8',
      });
      assert.equal(add.status, 0, add.stderr);

      const result = lintDeltaBodyCanonicalWrap({ changeFolder, repoRoot: root, baseRef: 'HEAD' });
      assert.equal(result.pass, true, `unexpected violations: ${JSON.stringify(result.violations)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Case 18: deletion-only canonical hunks retain base requirement attribution', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: DELTA_SINGLE_LINE_MATCHING,
      canonicalContent: CANONICAL_SINGLE_LINE_BODY,
    });
    const deletedCap = 'deleted-cap';
    const deletedCanonicalDir = join(root, 'openspec', 'specs', deletedCap);
    try {
      mkdirSync(deletedCanonicalDir, { recursive: true });
      writeFileSync(
        join(deletedCanonicalDir, 'spec.md'),
        CANONICAL_SINGLE_LINE_BODY.replaceAll('test-cap', deletedCap).replace('Widget Processing', 'Deleted Coverage'),
        'utf8',
      );
      commitFixtureBaseline(root);
      rmSync(join(deletedCanonicalDir, 'spec.md'));

      const result = lintDeltaBodyCanonicalWrap({ changeFolder, repoRoot: root, baseRef: 'HEAD' });
      assert.equal(result.pass, false, 'a deletion-only hunk must still be attributed to its base requirement');
      assert.deepEqual(
        result.violations.map(v => [v.kind, v.cap, v.requirement]),
        [['canonical-touch-missing-delta', deletedCap, 'Deleted Coverage']],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Case 18a: Windows repo-relative paths are normalized before deletion-only base lookup', () => {
    const deletedRequirement = `### Requirement: Deleted Coverage

The system SHALL preserve deleted coverage.

#### Scenario: Deleted
- **WHEN** deleted coverage is evaluated
- **THEN** the system SHALL preserve it

`;
    const baselineCanonical = `${CANONICAL_SINGLE_LINE_BODY}${deletedRequirement}`;
    const { root, changeFolder } = buildFixture({
      deltaContent: DELTA_SINGLE_LINE_MATCHING,
      canonicalContent: baselineCanonical,
    });
    let relativeCalls = 0;
    const windowsPathApi = {
      sep: '\\',
      relative(from, to) {
        relativeCalls += 1;
        return relative(from, to).replaceAll('/', '\\');
      },
    };
    try {
      commitFixtureBaseline(root);
      writeFileSync(
        join(root, 'openspec', 'specs', 'test-cap', 'spec.md'),
        CANONICAL_SINGLE_LINE_BODY,
        'utf8',
      );

      const result = lintDeltaBodyCanonicalWrap({
        changeFolder,
        repoRoot: root,
        baseRef: 'HEAD',
        pathApi: windowsPathApi,
      });

      assert.ok(relativeCalls > 0, 'the injected native path API must own repo-relative path calculation');
      assert.equal(result.pass, false, 'base content must load even when native relative() emits backslashes');
      assert.deepEqual(
        result.violations.map(v => [v.kind, v.cap, v.requirement]),
        [['canonical-touch-missing-delta', 'test-cap', 'Deleted Coverage']],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Case 18b: POSIX literal backslashes remain Git path identity', () => {
    const literalBackslashPath = 'openspec/specs/literal\\cap/spec.md';
    assert.equal(normalizeGitRelativePath(literalBackslashPath, posix), literalBackslashPath);
  });

  test('Case 19: base-aware lint does not pass early when the whole change specs directory is absent', () => {
    const root = join(tmpdir(), `lint-wrap-no-specs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const changeFolder = join(root, 'openspec', 'changes', 'test-change');
    const canonicalPath = join(root, 'openspec', 'specs', 'test-cap', 'spec.md');
    try {
      mkdirSync(changeFolder, { recursive: true });
      mkdirSync(join(root, 'openspec', 'specs', 'test-cap'), { recursive: true });
      writeFileSync(canonicalPath, CANONICAL_SINGLE_LINE_BODY, 'utf8');
      commitFixtureBaseline(root);
      writeFileSync(
        canonicalPath,
        CANONICAL_SINGLE_LINE_BODY.replace('process widgets efficiently', 'process widgets deterministically'),
        'utf8',
      );

      const result = lintDeltaBodyCanonicalWrap({ changeFolder, repoRoot: root, baseRef: 'HEAD' });
      assert.equal(result.pass, false, 'missing change specs directory must not hide canonical touches');
      assert.deepEqual(
        result.violations.map(v => [v.kind, v.cap, v.requirement]),
        [['canonical-touch-missing-delta', 'test-cap', 'Widget Processing']],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // --- Dependency-absorption escape hatch (Cases 20-25) ---
  //
  // A named dependency merged into the change touches canonical Requirements the
  // change author did not write. The touch check cannot tell those apart from the
  // author's own edits, so the change declares them explicitly. The hatch is
  // deliberately self-limiting: declaring a title the delta also mirrors, or a
  // title nothing was exempted for, is itself a violation.

  const CALLBACK_REQUIREMENT_TAIL = `### Requirement: Callback Waiting

The runtime SHALL poll while waiting.

#### Scenario: Waiting
- **WHEN** work is delegated
- **THEN** the runtime SHALL poll every minute

`;

  function absorptionDeclaration(...titles) {
    return `# Decisions

## Dependency-Absorbed Requirements

${titles.map(title => `- "${title}"`).join('\n')}
`;
  }

  function buildTouchedCallbackFixture({ deltaContent, declaredTitles }) {
    const baselineCanonical = `${CANONICAL_SINGLE_LINE_BODY}${CALLBACK_REQUIREMENT_TAIL}`;
    const currentCanonical = baselineCanonical
      .replace('The runtime SHALL poll while waiting.', 'The runtime SHALL wait for a completion callback when available.')
      .replace('the runtime SHALL poll every minute', 'the runtime SHALL NOT poll when a callback is available');
    const { root, changeFolder } = buildFixture({ deltaContent, canonicalContent: baselineCanonical });
    if (declaredTitles) {
      writeFileSync(join(changeFolder, 'decisions.md'), absorptionDeclaration(...declaredTitles), 'utf8');
    }
    commitFixtureBaseline(root);
    writeFileSync(join(root, 'openspec', 'specs', 'test-cap', 'spec.md'), currentCanonical, 'utf8');
    return { root, changeFolder };
  }

  test('Case 20: a declared dependency-absorbed Requirement exempts the canonical touch', () => {
    const { root, changeFolder } = buildTouchedCallbackFixture({
      deltaContent: DELTA_SINGLE_LINE_MATCHING,
      declaredTitles: ['Callback Waiting'],
    });
    try {
      const result = lintDeltaBodyCanonicalWrap({ changeFolder, repoRoot: root, baseRef: 'HEAD' });
      assert.equal(result.pass, true, `unexpected violations: ${JSON.stringify(result.violations)}`);
      assert.equal(result.violations.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Case 21: declaring a Requirement the delta also mirrors is a contradiction', () => {
    const deltaWithBothRequirements = `${DELTA_SINGLE_LINE_MATCHING}
### Requirement: Callback Waiting

The runtime SHALL wait for a completion callback when available.

#### Scenario: Waiting
- **WHEN** work is delegated
- **THEN** the runtime SHALL NOT poll when a callback is available

`;
    const { root, changeFolder } = buildTouchedCallbackFixture({
      deltaContent: deltaWithBothRequirements,
      declaredTitles: ['Callback Waiting'],
    });
    try {
      const result = lintDeltaBodyCanonicalWrap({ changeFolder, repoRoot: root, baseRef: 'HEAD' });
      assert.equal(result.pass, false, 'declaring and authoring the same Requirement must fail closed');
      assert.deepEqual(
        result.violations.map(v => [v.kind, v.cap, v.requirement]),
        [['dependency-absorbed-declared-but-mirrored', null, 'Callback Waiting']],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Case 22: a declaration that exempts nothing is reported as unused', () => {
    const { root, changeFolder } = buildTouchedCallbackFixture({
      deltaContent: DELTA_SINGLE_LINE_MATCHING,
      declaredTitles: ['Callback Waiting', 'Never Touched Requirement'],
    });
    try {
      const result = lintDeltaBodyCanonicalWrap({ changeFolder, repoRoot: root, baseRef: 'HEAD' });
      assert.equal(result.pass, false, 'a blanket declaration must not pass silently');
      assert.deepEqual(
        result.violations.map(v => [v.kind, v.cap, v.requirement]),
        [['dependency-absorbed-declaration-unused', null, 'Never Touched Requirement']],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Case 23: without a base ref the declaration is entirely inert', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: DELTA_SINGLE_LINE_MATCHING,
      canonicalContent: CANONICAL_SINGLE_LINE_BODY,
    });
    try {
      writeFileSync(
        join(changeFolder, 'decisions.md'),
        absorptionDeclaration('Callback Waiting', 'Never Touched Requirement'),
        'utf8',
      );

      const result = lintDeltaBodyCanonicalWrap({ changeFolder, repoRoot: root });
      assert.equal(result.pass, true, `unexpected violations: ${JSON.stringify(result.violations)}`);
      assert.equal(result.violations.length, 0, 'no base ref means nothing to exempt and nothing to report unused');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Case 24: a declaration exempts a touched capability with no delta capability folder', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: DELTA_SINGLE_LINE_MATCHING,
      canonicalContent: CANONICAL_SINGLE_LINE_BODY,
    });
    const missingCap = 'missing-cap';
    const missingCanonicalDir = join(root, 'openspec', 'specs', missingCap);
    try {
      writeFileSync(join(changeFolder, 'tasks.md'), absorptionDeclaration('Missing Delta Coverage'), 'utf8');
      commitFixtureBaseline(root);
      mkdirSync(missingCanonicalDir, { recursive: true });
      writeFileSync(
        join(missingCanonicalDir, 'spec.md'),
        CANONICAL_SINGLE_LINE_BODY.replaceAll('test-cap', missingCap).replace('Widget Processing', 'Missing Delta Coverage'),
        'utf8',
      );
      const add = spawnSync('git', ['add', join('openspec', 'specs', missingCap, 'spec.md')], {
        cwd: root,
        encoding: 'utf8',
      });
      assert.equal(add.status, 0, add.stderr);

      const result = lintDeltaBodyCanonicalWrap({ changeFolder, repoRoot: root, baseRef: 'HEAD' });
      assert.equal(result.pass, true, `unexpected violations: ${JSON.stringify(result.violations)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  const OTHER_CAP_AUTHORED_CALLBACK = `# other-cap Spec Delta

## ADDED Requirements

### Requirement: Callback Waiting

The runtime SHALL wait for a completion callback when available.

#### Scenario: Waiting
- **WHEN** work is delegated
- **THEN** the runtime SHALL NOT poll when a callback is available

`;

  test('Case 25: an unused declaration authored in another capability delta reports mirrored, not unused', () => {
    // Distinguishes the two failure messages: the author DID write this title,
    // just not where the declaration would have helped. Requires the mirrored
    // check to see every capability delta, not only the touched capability's.
    const { root, changeFolder } = buildFixture({
      deltaContent: DELTA_SINGLE_LINE_MATCHING,
      canonicalContent: CANONICAL_SINGLE_LINE_BODY,
    });
    try {
      writeFileSync(join(changeFolder, 'decisions.md'), absorptionDeclaration('Callback Waiting'), 'utf8');
      const otherDeltaDir = join(changeFolder, 'specs', 'other-cap');
      mkdirSync(otherDeltaDir, { recursive: true });
      writeFileSync(join(otherDeltaDir, 'spec.md'), OTHER_CAP_AUTHORED_CALLBACK, 'utf8');
      commitFixtureBaseline(root);

      const result = lintDeltaBodyCanonicalWrap({ changeFolder, repoRoot: root, baseRef: 'HEAD' });
      assert.equal(result.pass, false, 'a declaration that exempted nothing must still fail closed');
      assert.deepEqual(
        result.violations.map(v => [v.kind, v.cap, v.requirement]),
        [['dependency-absorbed-declared-but-mirrored', null, 'Callback Waiting']],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Case 26: a declaration that did exempt a touch stays valid even if the title is authored elsewhere', () => {
    // Precedence is used -> mirrored -> unused. Title-only declaration granularity
    // (decisions.md D3) cannot tell a same-titled Requirement in another capability
    // apart from the absorbed one, and refusing here would leave the exempted
    // capability with no legal fix. Accepted cost, locked so it stays deliberate.
    const { root, changeFolder } = buildTouchedCallbackFixture({
      deltaContent: DELTA_SINGLE_LINE_MATCHING,
      declaredTitles: ['Callback Waiting'],
    });
    try {
      const otherDeltaDir = join(changeFolder, 'specs', 'other-cap');
      mkdirSync(otherDeltaDir, { recursive: true });
      writeFileSync(join(otherDeltaDir, 'spec.md'), OTHER_CAP_AUTHORED_CALLBACK, 'utf8');

      const result = lintDeltaBodyCanonicalWrap({ changeFolder, repoRoot: root, baseRef: 'HEAD' });
      assert.equal(result.pass, true, `unexpected violations: ${JSON.stringify(result.violations)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // --- RENAMED Requirements canonical-touch coverage (Cases 27-31) ---
  //
  // A RENAMED Requirement's base-side (FROM) title is always in the diff's base
  // span, and its current-side (TO) title in the current span, so both are
  // "touched". The TO title is already exempt via the pre-existing
  // deltaRequirementNames membership check when it is authored under
  // `## MODIFIED Requirements`. The FROM title needs its own exemption: it is
  // covered only when the SAME delta file declares a `## RENAMED Requirements`
  // FROM -> TO pair for it AND that TO title is authored in that same file.

  function buildRenamedCallbackFixture({ deltaContent, otherCapContent }) {
    const baselineCanonical = `${CANONICAL_SINGLE_LINE_BODY}${CALLBACK_REQUIREMENT_TAIL}`;
    const currentCanonical = baselineCanonical.replace(
      '### Requirement: Callback Waiting',
      '### Requirement: Callback Handling',
    );
    const { root, changeFolder } = buildFixture({ deltaContent, canonicalContent: baselineCanonical });
    if (otherCapContent) {
      const otherDeltaDir = join(changeFolder, 'specs', 'other-cap');
      mkdirSync(otherDeltaDir, { recursive: true });
      writeFileSync(join(otherDeltaDir, 'spec.md'), otherCapContent, 'utf8');
    }
    commitFixtureBaseline(root);
    writeFileSync(join(root, 'openspec', 'specs', 'test-cap', 'spec.md'), currentCanonical, 'utf8');
    return { root, changeFolder };
  }

  const DELTA_RENAME_MODIFIED_COVERED = `# test-cap Spec Delta

## RENAMED Requirements

- FROM: \`### Requirement: Callback Waiting\`
- TO: \`### Requirement: Callback Handling\`

## MODIFIED Requirements

### Requirement: Callback Handling

The runtime SHALL poll while waiting.

#### Scenario: Waiting
- **WHEN** work is delegated
- **THEN** the runtime SHALL poll every minute

`;

  test('Case 27: RENAMED FROM->TO pair with TO authored as MODIFIED covers the old title → pass', () => {
    const { root, changeFolder } = buildRenamedCallbackFixture({
      deltaContent: DELTA_RENAME_MODIFIED_COVERED,
    });
    try {
      const result = lintDeltaBodyCanonicalWrap({ changeFolder, repoRoot: root, baseRef: 'HEAD' });
      assert.deepEqual(
        result.violations.map(v => [v.kind, v.cap, v.requirement]),
        [],
      );
      assert.equal(result.pass, true, `unexpected violations: ${JSON.stringify(result.violations)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  const DELTA_RENAME_ONLY_TO_NOT_AUTHORED = `# test-cap Spec Delta

## RENAMED Requirements

- FROM: \`### Requirement: Callback Waiting\`
- TO: \`### Requirement: Callback Handling\`

`;

  test('Case 28: RENAMED FROM->TO pair whose TO is never authored → violation for both titles', () => {
    const { root, changeFolder } = buildRenamedCallbackFixture({
      deltaContent: DELTA_RENAME_ONLY_TO_NOT_AUTHORED,
    });
    try {
      const result = lintDeltaBodyCanonicalWrap({ changeFolder, repoRoot: root, baseRef: 'HEAD' });
      assert.deepEqual(
        result.violations.map(v => [v.kind, v.cap, v.requirement]),
        [
          ['canonical-touch-missing-delta', 'test-cap', 'Callback Waiting'],
          ['canonical-touch-missing-delta', 'test-cap', 'Callback Handling'],
        ],
      );
      assert.equal(result.pass, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  const DELTA_RENAME_UNRELATED_PAIR = `# test-cap Spec Delta

## RENAMED Requirements

- FROM: \`### Requirement: Foo Bar\`
- TO: \`### Requirement: Baz Qux\`

## MODIFIED Requirements

### Requirement: Callback Handling

The runtime SHALL poll while waiting.

#### Scenario: Waiting
- **WHEN** work is delegated
- **THEN** the runtime SHALL poll every minute

`;

  test('Case 29: RENAMED pair FROM title unrelated to the touched title → violation for the touched title', () => {
    const { root, changeFolder } = buildRenamedCallbackFixture({
      deltaContent: DELTA_RENAME_UNRELATED_PAIR,
    });
    try {
      const result = lintDeltaBodyCanonicalWrap({ changeFolder, repoRoot: root, baseRef: 'HEAD' });
      assert.deepEqual(
        result.violations.map(v => [v.kind, v.cap, v.requirement]),
        [['canonical-touch-missing-delta', 'test-cap', 'Callback Waiting']],
      );
      assert.equal(result.pass, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  const DELTA_RENAME_MALFORMED_PAIR = `# test-cap Spec Delta

## RENAMED Requirements

- FROM: \`### Requirement: Callback Waiting\`

## MODIFIED Requirements

### Requirement: Callback Handling

The runtime SHALL poll while waiting.

#### Scenario: Waiting
- **WHEN** work is delegated
- **THEN** the runtime SHALL poll every minute

`;

  test('Case 30: RENAMED FROM bullet with no TO (malformed pair) → violation for the old title', () => {
    const { root, changeFolder } = buildRenamedCallbackFixture({
      deltaContent: DELTA_RENAME_MALFORMED_PAIR,
    });
    try {
      const result = lintDeltaBodyCanonicalWrap({ changeFolder, repoRoot: root, baseRef: 'HEAD' });
      assert.deepEqual(
        result.violations.map(v => [v.kind, v.cap, v.requirement]),
        [['canonical-touch-missing-delta', 'test-cap', 'Callback Waiting']],
      );
      assert.equal(result.pass, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  const DELTA_CALLBACK_HANDLING_MODIFIED_ONLY = `# test-cap Spec Delta

## MODIFIED Requirements

### Requirement: Callback Handling

The runtime SHALL poll while waiting.

#### Scenario: Waiting
- **WHEN** work is delegated
- **THEN** the runtime SHALL poll every minute

`;

  const OTHER_CAP_RENAME_PAIR_FOR_CALLBACK = `# other-cap Spec Delta

## RENAMED Requirements

- FROM: \`### Requirement: Callback Waiting\`
- TO: \`### Requirement: Callback Handling\`

## MODIFIED Requirements

### Requirement: Callback Handling

The runtime SHALL wait for a completion callback when available.

#### Scenario: Waiting
- **WHEN** work is delegated
- **THEN** the runtime SHALL NOT poll when a callback is available

`;

  test('Case 31: a RENAMED FROM->TO pair declared in a different capability delta does not cover this capability\'s touch', () => {
    const { root, changeFolder } = buildRenamedCallbackFixture({
      deltaContent: DELTA_CALLBACK_HANDLING_MODIFIED_ONLY,
      otherCapContent: OTHER_CAP_RENAME_PAIR_FOR_CALLBACK,
    });
    try {
      const result = lintDeltaBodyCanonicalWrap({ changeFolder, repoRoot: root, baseRef: 'HEAD' });
      assert.deepEqual(
        result.violations.map(v => [v.kind, v.cap, v.requirement]),
        [['canonical-touch-missing-delta', 'test-cap', 'Callback Waiting']],
      );
      assert.equal(result.pass, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// --- CLI-level tests (spawn-based): exit code and stderr/stdout contract ---

describe('lint-delta-body-canonical-wrap CLI', () => {
  // CLI Case A: hard-wrap → exit 1 + stderr contains "body line-structure drift"
  test('CLI Case A: hard-wrapped delta → exit 1 + stderr body line-structure drift', () => {
    const root = join(tmpdir(), `lint-wrap-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const changeName = 'cli-test-change';
    const cap = 'cli-test-cap';
    const changeFolder = join(root, 'openspec', 'changes', changeName);
    const deltaSpecDir = join(changeFolder, 'specs', cap);
    const canonicalSpecDir = join(root, 'openspec', 'specs', cap);

    mkdirSync(deltaSpecDir, { recursive: true });
    mkdirSync(canonicalSpecDir, { recursive: true });

    writeFileSync(join(canonicalSpecDir, 'spec.md'), CANONICAL_SINGLE_LINE_BODY, 'utf8');
    writeFileSync(join(deltaSpecDir, 'spec.md'), DELTA_HARD_WRAPPED, 'utf8');

    try {
      const r = spawnSync('node', [SCRIPT, changeFolder], { encoding: 'utf8' });
      assert.equal(r.status, 1, `expected exit 1 but got ${r.status}; stdout=${r.stdout}; stderr=${r.stderr}`);
      assert.match(r.stderr, /body line-structure drift/, 'stderr must contain "body line-structure drift"');
      assert.match(r.stderr, /Requirement "Widget Processing"/, 'stderr must contain the requirement name');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // CLI Case B: consistent wrap → exit 0 + stdout contains "pass"
  test('CLI Case B: consistent wrap → exit 0 + stdout contains pass', () => {
    const root = join(tmpdir(), `lint-wrap-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const changeName = 'cli-test-change';
    const cap = 'cli-test-cap';
    const changeFolder = join(root, 'openspec', 'changes', changeName);
    const deltaSpecDir = join(changeFolder, 'specs', cap);
    const canonicalSpecDir = join(root, 'openspec', 'specs', cap);

    mkdirSync(deltaSpecDir, { recursive: true });
    mkdirSync(canonicalSpecDir, { recursive: true });

    writeFileSync(join(canonicalSpecDir, 'spec.md'), CANONICAL_SINGLE_LINE_BODY, 'utf8');
    writeFileSync(join(deltaSpecDir, 'spec.md'), DELTA_SINGLE_LINE_MATCHING, 'utf8');

    try {
      const r = spawnSync('node', [SCRIPT, changeFolder], { encoding: 'utf8' });
      assert.equal(r.status, 0, `expected exit 0 but got ${r.status}; stdout=${r.stdout}; stderr=${r.stderr}`);
      assert.match(r.stdout, /pass/, 'stdout must contain "pass"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('CLI Case C: --base rejects a touched canonical requirement missing from delta', () => {
    const baselineCanonical = `${CANONICAL_SINGLE_LINE_BODY}
### Requirement: Callback Waiting

The runtime SHALL poll while waiting.

#### Scenario: Waiting
- **WHEN** work is delegated
- **THEN** the runtime SHALL poll every minute

`;
    const { root, changeFolder } = buildFixture({
      deltaContent: DELTA_SINGLE_LINE_MATCHING,
      canonicalContent: baselineCanonical,
    });
    try {
      commitFixtureBaseline(root);
      writeFileSync(
        join(root, 'openspec', 'specs', 'test-cap', 'spec.md'),
        baselineCanonical.replace('The runtime SHALL poll while waiting.', 'The runtime SHALL wait for a completion callback.'),
        'utf8',
      );

      const r = spawnSync('node', [SCRIPT, changeFolder, '--base', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
      });
      assert.equal(r.status, 1, `expected exit 1 but got ${r.status}; stdout=${r.stdout}; stderr=${r.stderr}`);
      assert.match(r.stderr, /Requirement "Callback Waiting"/);
      assert.match(r.stderr, /canonical touched since HEAD but absent from active delta/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('CLI Case D: --base fails closed on an invalid change base ref', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: DELTA_SINGLE_LINE_MATCHING,
      canonicalContent: CANONICAL_SINGLE_LINE_BODY,
    });
    try {
      commitFixtureBaseline(root);
      const r = spawnSync('node', [SCRIPT, changeFolder, '--base', 'refs/heads/does-not-exist'], {
        cwd: root,
        encoding: 'utf8',
      });
      assert.equal(r.status, 1, `expected exit 1 but got ${r.status}; stdout=${r.stdout}; stderr=${r.stderr}`);
      assert.match(r.stderr, /invalid change base ref: refs\/heads\/does-not-exist/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('CLI Case E: both dependency-absorption violation kinds are reported with distinct guidance', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: DELTA_SINGLE_LINE_MATCHING,
      canonicalContent: CANONICAL_SINGLE_LINE_BODY,
    });
    try {
      writeFileSync(
        join(changeFolder, 'decisions.md'),
        '# Decisions\n\n## Dependency-Absorbed Requirements\n\n- "Widget Processing"\n- "Never Touched Requirement"\n',
        'utf8',
      );
      commitFixtureBaseline(root);

      const r = spawnSync('node', [SCRIPT, changeFolder, '--base', 'HEAD'], { cwd: root, encoding: 'utf8' });
      assert.equal(r.status, 1, `expected exit 1 but got ${r.status}; stdout=${r.stdout}; stderr=${r.stderr}`);
      assert.match(r.stderr, /Requirement "Widget Processing" :: declared dependency-absorbed but also authored in this change's delta/);
      assert.match(r.stderr, /Requirement "Never Touched Requirement" :: declared dependency-absorbed but exempted nothing/);
      assert.match(r.stderr, /Dependency-absorption fix:/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Case 21: an archived change folder derives the repo root one level deeper (no repoRoot passed)', () => {
    const { root } = buildFixture({
      deltaContent: DELTA_HARD_WRAPPED,
      canonicalContent: CANONICAL_SINGLE_LINE_BODY,
    });
    try {
      const archivedFolder = join(root, 'openspec', 'changes', 'archive', '2026-01-01-test-change');
      mkdirSync(join(root, 'openspec', 'changes', 'archive'), { recursive: true });
      renameSync(join(root, 'openspec', 'changes', 'test-change'), archivedFolder);

      const result = lintDeltaBodyCanonicalWrap({ changeFolder: archivedFolder });
      assert.equal(result.pass, false, 'the hard-wrapped delta must be compared against the canonical spec, not silently skipped');
      assert.ok(result.violations.length > 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('canonical corpus contains no delta-only requirement mode headings', () => {
    const canonicalRoot = join(SOURCE_ROOT, 'openspec', 'specs');
    const violations = [];

    for (const entry of readdirSync(canonicalRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const relativePath = posix.join('openspec', 'specs', entry.name, 'spec.md');
      const content = readFileSync(join(SOURCE_ROOT, relativePath), 'utf8');
      content.split(/\r?\n/).forEach((line, index) => {
        if (/^## (?:ADDED|MODIFIED|REMOVED|RENAMED) Requirements$/.test(line)) {
          violations.push(`${relativePath}:${index + 1}: ${line}`);
        }
      });
    }

    assert.deepEqual(
      violations,
      [],
      `canonical specs must not retain delta-only requirement mode headings:\n${violations.join('\n')}`,
    );
  });
});

// A supplied-but-unusable --base must fail closed. Treating an empty value as "no base"
// silently switched off the canonical-touch check that --base exists to run.
describe('lint-delta-body-canonical-wrap — an unusable --base never falls back to the legacy comparison', () => {
  /** Canonical gained a touched Requirement that the delta does not mirror (Case 13 shape). */
  function touchedCanonicalFixture() {
    const baselineCanonical = `${CANONICAL_SINGLE_LINE_BODY}
### Requirement: Callback Waiting

The runtime SHALL poll while waiting.

#### Scenario: Waiting
- **WHEN** work is delegated
- **THEN** the runtime SHALL poll every minute

`;
    const currentCanonical = baselineCanonical
      .replace('The runtime SHALL poll while waiting.', 'The runtime SHALL wait for a completion callback when available.')
      .replace('the runtime SHALL poll every minute', 'the runtime SHALL NOT poll when a callback is available');
    const fixture = buildFixture({
      deltaContent: DELTA_SINGLE_LINE_MATCHING,
      canonicalContent: baselineCanonical,
    });
    commitFixtureBaseline(fixture.root);
    writeFileSync(join(fixture.root, 'openspec', 'specs', 'test-cap', 'spec.md'), currentCanonical, 'utf8');
    return fixture;
  }

  test('an empty or non-string base ref reports an invalid change base ref', () => {
    const { root, changeFolder } = touchedCanonicalFixture();
    try {
      for (const baseRef of ['', 0, false, {}]) {
        const result = lintDeltaBodyCanonicalWrap({ changeFolder, repoRoot: root, baseRef });
        assert.equal(result.pass, false, `baseRef ${JSON.stringify(baseRef)} must not pass`);
        assert.match(result.error, /invalid change base ref/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an omitted base (undefined or null) keeps the legacy comparison', () => {
    const { root, changeFolder } = touchedCanonicalFixture();
    try {
      for (const baseRef of [undefined, null]) {
        const result = lintDeltaBodyCanonicalWrap({ changeFolder, repoRoot: root, baseRef });
        assert.equal(result.pass, true, JSON.stringify(result));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('CLI --base with an empty value exits 1, an omitted --base keeps exiting 0', () => {
    const { root, changeFolder } = touchedCanonicalFixture();
    try {
      const empty = spawnSync('node', [SCRIPT, changeFolder, '--base', ''], { encoding: 'utf8' });
      assert.equal(empty.status, 1, `stdout=${empty.stdout}; stderr=${empty.stderr}`);
      assert.match(empty.stderr, /invalid change base ref/);
      const omitted = spawnSync('node', [SCRIPT, changeFolder], { encoding: 'utf8' });
      assert.equal(omitted.status, 0, `stdout=${omitted.stdout}; stderr=${omitted.stderr}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
