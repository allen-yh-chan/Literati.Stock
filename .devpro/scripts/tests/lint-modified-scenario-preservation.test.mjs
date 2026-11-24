import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { lintModifiedScenarioPreservation, deltaContainsRemovedScenariosHeading } from '../lint-modified-scenario-preservation.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'lint-modified-scenario-preservation.mjs');

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
 *         proposal-mini.md       (optional)
 *         tasks.md               (optional)
 *         decisions.md           (optional)
 *       specs/<cap>/spec.md      (canonical)
 *
 * Returns { root, changeFolder } for use with lintModifiedScenarioPreservation.
 */
function buildFixture({
  changeName = 'test-change',
  cap = 'test-cap',
  deltaContent,
  canonicalContent,
  proposalMini,
  tasks,
  decisions,
}) {
  const root = join(tmpdir(), `lint-msp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const changeFolder = join(root, 'openspec', 'changes', changeName);
  const deltaSpecDir = join(changeFolder, 'specs', cap);
  const canonicalSpecDir = join(root, 'openspec', 'specs', cap);

  mkdirSync(deltaSpecDir, { recursive: true });
  mkdirSync(canonicalSpecDir, { recursive: true });

  if (deltaContent !== undefined) {
    writeFileSync(join(deltaSpecDir, 'spec.md'), deltaContent, 'utf8');
  }
  if (canonicalContent !== undefined) {
    writeFileSync(join(canonicalSpecDir, 'spec.md'), canonicalContent, 'utf8');
  }
  if (proposalMini !== undefined) {
    writeFileSync(join(changeFolder, 'proposal-mini.md'), proposalMini, 'utf8');
  }
  if (tasks !== undefined) {
    writeFileSync(join(changeFolder, 'tasks.md'), tasks, 'utf8');
  }
  if (decisions !== undefined) {
    writeFileSync(join(changeFolder, 'decisions.md'), decisions, 'utf8');
  }

  return { root, changeFolder };
}

// --- Canonical spec template with two scenarios ---
const CANONICAL_WITH_TWO_SCENARIOS = `# test-cap Specification

## Purpose

Test canonical spec.

## Requirements

### Requirement: Widget Processing

The system SHALL process widgets efficiently.

#### Scenario: Happy Path
- **WHEN** a valid widget is submitted
- **THEN** the system SHALL accept it
- **AND** return 200

#### Scenario: Invalid Input
- **WHEN** an invalid widget is submitted
- **THEN** the system SHALL reject it with code 400

`;

// --- Delta with both canonical scenarios preserved ---
const DELTA_MODIFIED_ALL_SCENARIOS = `# test-cap Spec Delta

## MODIFIED Requirements

### Requirement: Widget Processing

The system SHALL process widgets efficiently (updated).

#### Scenario: Happy Path
- **WHEN** a valid widget is submitted
- **THEN** the system SHALL accept it
- **AND** return 200

#### Scenario: Invalid Input
- **WHEN** an invalid widget is submitted
- **THEN** the system SHALL reject it with code 400

`;

// --- Delta missing "Invalid Input" scenario ---
const DELTA_MODIFIED_MISSING_ONE = `# test-cap Spec Delta

## MODIFIED Requirements

### Requirement: Widget Processing

The system SHALL process widgets efficiently (updated).

#### Scenario: Happy Path
- **WHEN** a valid widget is submitted
- **THEN** the system SHALL accept it
- **AND** return 200

`;

// #1968 shape: MODIFIED lists only a newly added scenario (wipes siblings).
const DELTA_NEW_SCENARIO_ONLY_WIPE = `# test-cap Spec Delta

## MODIFIED Requirements

### Requirement: Widget Processing

The system SHALL process widgets efficiently (updated).

#### Scenario: Brand New Path
- **WHEN** a novel widget is submitted
- **THEN** the system SHALL accept the novel path

`;

const DELTA_RESTATE_WITH_NEW = `# test-cap Spec Delta

## MODIFIED Requirements

### Requirement: Widget Processing

The system SHALL process widgets efficiently (updated).

#### Scenario: Happy Path
- **WHEN** a valid widget is submitted
- **THEN** the system SHALL accept it
- **AND** return 200

#### Scenario: Invalid Input
- **WHEN** an invalid widget is submitted
- **THEN** the system SHALL reject it with code 400

#### Scenario: Brand New Path
- **WHEN** a novel widget is submitted
- **THEN** the system SHALL accept the novel path

`;

const DELTA_CONTIGUOUS_ADDITIVE = `# test-cap Spec Delta

## MODIFIED Requirements

### Requirement: Widget Processing

The system SHALL process widgets efficiently.

#### Scenario: Happy Path
- **WHEN** a valid widget is submitted
- **THEN** the system SHALL accept it
- **AND** return 200

#### Scenario: Brand New Path
- **WHEN** a novel widget is submitted
- **THEN** the system SHALL accept the novel path

#### Scenario: Invalid Input
- **WHEN** an invalid widget is submitted
- **THEN** the system SHALL reject it with code 400

`;

describe('lint-modified-scenario-preservation', () => {
  // Case 1: delta MODIFIED drops a canonical scenario → pass:false
  test('Case 1: delta MODIFIED missing one canonical scenario → violation', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: DELTA_MODIFIED_MISSING_ONE,
      canonicalContent: CANONICAL_WITH_TWO_SCENARIOS,
    });
    try {
      const result = lintModifiedScenarioPreservation({ changeFolder, repoRoot: root });
      assert.equal(result.pass, false, 'expected pass:false when scenario is missing');
      assert.equal(result.violations.length, 1);
      const v = result.violations[0];
      assert.equal(v.cap, 'test-cap');
      assert.equal(v.requirement, 'Widget Processing');
      assert.equal(v.missing.length, 1);
      assert.match(v.missing[0], /Invalid Input/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Case 1b: CRLF delta MODIFIED missing one canonical scenario → violation', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: toCrlf(DELTA_MODIFIED_MISSING_ONE),
      canonicalContent: CANONICAL_WITH_TWO_SCENARIOS,
    });
    try {
      const result = lintModifiedScenarioPreservation({ changeFolder, repoRoot: root });
      assert.equal(result.pass, false, 'expected pass:false when CRLF delta drops a scenario');
      assert.equal(result.violations.length, 1);
      const v = result.violations[0];
      assert.equal(v.cap, 'test-cap');
      assert.equal(v.requirement, 'Widget Processing');
      assert.equal(v.missing.length, 1);
      assert.match(v.missing[0], /Invalid Input/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Case 2: delta MODIFIED contains all canonical scenarios → pass:true
  test('Case 2: delta MODIFIED preserves all canonical scenarios → pass', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: DELTA_MODIFIED_ALL_SCENARIOS,
      canonicalContent: CANONICAL_WITH_TWO_SCENARIOS,
    });
    try {
      const result = lintModifiedScenarioPreservation({ changeFolder, repoRoot: root });
      assert.equal(result.pass, true, `unexpected violations: ${JSON.stringify(result.violations)}`);
      assert.equal(result.violations.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // #1968 shape: new-scenario-only MODIFIED wipes undeclared siblings → pass:false
  test('Case 1c (#1968): new-scenario-only MODIFIED wipes sibling scenarios → violation', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: DELTA_NEW_SCENARIO_ONLY_WIPE,
      canonicalContent: CANONICAL_WITH_TWO_SCENARIOS,
    });
    try {
      const result = lintModifiedScenarioPreservation({ changeFolder, repoRoot: root });
      assert.equal(result.pass, false, 'expected pass:false for new-scenario-only wipe');
      assert.equal(result.violations.length, 1);
      const missing = result.violations[0].missing.join(' ');
      assert.match(missing, /Happy Path/);
      assert.match(missing, /Invalid Input/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Case 2b: restate path with new scenario → pass', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: DELTA_RESTATE_WITH_NEW,
      canonicalContent: CANONICAL_WITH_TWO_SCENARIOS,
    });
    try {
      const result = lintModifiedScenarioPreservation({ changeFolder, repoRoot: root });
      assert.equal(result.pass, true, `unexpected violations: ${JSON.stringify(result.violations)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Case 2c: contiguous additive insert → pass', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: DELTA_CONTIGUOUS_ADDITIVE,
      canonicalContent: CANONICAL_WITH_TWO_SCENARIOS,
    });
    try {
      const result = lintModifiedScenarioPreservation({ changeFolder, repoRoot: root });
      assert.equal(result.pass, true, `unexpected violations: ${JSON.stringify(result.violations)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Case 3a: Removed Scenarios declared in proposal-mini.md → pass:true
  test('Case 3a: Removed Scenarios authorized in proposal-mini.md → pass', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: DELTA_MODIFIED_MISSING_ONE,
      canonicalContent: CANONICAL_WITH_TWO_SCENARIOS,
      proposalMini: `# proposal-mini

## Why

Some reason.

## Removed Scenarios
- "Invalid Input"

## Tasks
`,
    });
    try {
      const result = lintModifiedScenarioPreservation({ changeFolder, repoRoot: root });
      assert.equal(result.pass, true, `unexpected violations: ${JSON.stringify(result.violations)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Case 3b: Removed Scenarios declared in tasks.md → pass:true
  test('Case 3b: Removed Scenarios authorized in tasks.md → pass', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: DELTA_MODIFIED_MISSING_ONE,
      canonicalContent: CANONICAL_WITH_TWO_SCENARIOS,
      tasks: `# Tasks

## Removed Scenarios
- Invalid Input

## Implementation
`,
    });
    try {
      const result = lintModifiedScenarioPreservation({ changeFolder, repoRoot: root });
      assert.equal(result.pass, true, `unexpected violations: ${JSON.stringify(result.violations)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Case 3c: Removed Scenarios declared in decisions.md → pass:true
  test('Case 3c: Removed Scenarios authorized in decisions.md → pass', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: DELTA_MODIFIED_MISSING_ONE,
      canonicalContent: CANONICAL_WITH_TWO_SCENARIOS,
      decisions: `# Decisions

## Removed Scenarios
- \`Invalid Input\`

## Other Decisions
`,
    });
    try {
      const result = lintModifiedScenarioPreservation({ changeFolder, repoRoot: root });
      assert.equal(result.pass, true, `unexpected violations: ${JSON.stringify(result.violations)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Case 4: canonical has no matching Requirement name → skip → pass:true
  test('Case 4: delta MODIFIED unknown Requirement (no canonical match) → skip → pass', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: `# test-cap Spec Delta

## MODIFIED Requirements

### Requirement: Non Existent Requirement

The system SHALL do something.

#### Scenario: Only Scenario
- **WHEN** something
- **THEN** the system SHALL respond

`,
      canonicalContent: CANONICAL_WITH_TWO_SCENARIOS,
    });
    try {
      const result = lintModifiedScenarioPreservation({ changeFolder, repoRoot: root });
      assert.equal(result.pass, true, `unexpected violations: ${JSON.stringify(result.violations)}`);
      assert.equal(result.violations.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Case 5: new capability (canonical spec.md does not exist) → skip → pass:true
  test('Case 5: canonical spec.md does not exist (new capability) → skip → pass', () => {
    const root = join(tmpdir(), `lint-msp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const changeName = 'test-change';
    const cap = 'brand-new-capability';
    const changeFolder = join(root, 'openspec', 'changes', changeName);
    const deltaSpecDir = join(changeFolder, 'specs', cap);
    // Only create delta, no canonical
    mkdirSync(deltaSpecDir, { recursive: true });
    writeFileSync(join(deltaSpecDir, 'spec.md'), DELTA_MODIFIED_MISSING_ONE, 'utf8');
    // Note: canonical dir NOT created
    try {
      const result = lintModifiedScenarioPreservation({ changeFolder, repoRoot: root });
      assert.equal(result.pass, true, `unexpected violations: ${JSON.stringify(result.violations)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Case 6: delta has only ADDED block (no MODIFIED) → pass:true
  test('Case 6: delta with only ADDED Requirements → no MODIFIED block → pass', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: `# test-cap Spec Delta

## ADDED Requirements

### Requirement: Brand New Widget

The system SHALL support brand new widgets.

#### Scenario: Happy Path
- **WHEN** a brand new widget is submitted
- **THEN** the system SHALL accept it

`,
      canonicalContent: CANONICAL_WITH_TWO_SCENARIOS,
    });
    try {
      const result = lintModifiedScenarioPreservation({ changeFolder, repoRoot: root });
      assert.equal(result.pass, true, `unexpected violations: ${JSON.stringify(result.violations)}`);
      assert.equal(result.violations.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Case 7: ADDED+MODIFIED mixed — ADDED block has a Requirement name matching a canonical
  // Requirement but only partial scenarios; MODIFIED has a DIFFERENT canonical Requirement
  // with all scenarios. Lint MUST only look at MODIFIED block → pass:true
  test('Case 7: ADDED+MODIFIED mixed — ADDED collides with canonical name but only MODIFIED is checked → pass', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: `# test-cap Spec Delta

## ADDED Requirements

### Requirement: Widget Processing

The system SHALL process widgets in a new way.

#### Scenario: Happy Path
- **WHEN** a valid widget is submitted
- **THEN** the system SHALL accept it and process via new algorithm

## MODIFIED Requirements

### Requirement: Widget Processing

The system SHALL process widgets efficiently (patched).

#### Scenario: Happy Path
- **WHEN** a valid widget is submitted
- **THEN** the system SHALL accept it
- **AND** return 200

#### Scenario: Invalid Input
- **WHEN** an invalid widget is submitted
- **THEN** the system SHALL reject it with code 400

`,
      canonicalContent: CANONICAL_WITH_TWO_SCENARIOS,
    });
    try {
      // ADDED block has "Widget Processing" with only "Happy Path" (missing "Invalid Input").
      // But lint only checks MODIFIED block, where both scenarios are present.
      const result = lintModifiedScenarioPreservation({ changeFolder, repoRoot: root });
      assert.equal(result.pass, true, `unexpected violations: ${JSON.stringify(result.violations)}`);
      assert.equal(result.violations.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // #2658 / D5 / F4
  test('delta-local ## Removed Scenarios fails even when four-file declaration exists', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: `${DELTA_MODIFIED_MISSING_ONE}\n## Removed Scenarios\n- "Invalid Input"\n`,
      canonicalContent: CANONICAL_WITH_TWO_SCENARIOS,
      proposalMini: `## Removed Scenarios\n- "Invalid Input"\n`,
    });
    try {
      const result = lintModifiedScenarioPreservation({ changeFolder, repoRoot: root });
      assert.equal(result.pass, false);
      assert.equal((result.locationErrors ?? []).length, 1);
      assert.match(result.locationErrors[0].path, /specs\/test-cap\/spec\.md$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('deltaContainsRemovedScenariosHeading follows the CommonMark fence rules of the shared helper', () => {
    assert.equal(
      deltaContainsRemovedScenariosHeading('```x``` inline span\n## Removed Scenarios\n- "x"\n'),
      true,
      'a line starting with an inline backtick span is not a fence opener',
    );
    assert.equal(
      deltaContainsRemovedScenariosHeading('```\n```js\n## Removed Scenarios\n- "x"\n```\n'),
      false,
      'an info-string fence line inside a fence does not close it',
    );
    assert.equal(
      deltaContainsRemovedScenariosHeading('````\n```\n## Removed Scenarios\n````\n'),
      false,
      'a shorter run does not close a longer fence',
    );
  });

  test('fenced or inline ## Removed Scenarios mentions do not fail location check', () => {
    assert.equal(
      deltaContainsRemovedScenariosHeading('See `## Removed Scenarios` in the four files.\n'),
      false,
    );
    assert.equal(
      deltaContainsRemovedScenariosHeading('```\n## Removed Scenarios\n- "x"\n```\n'),
      false,
    );
    const { root, changeFolder } = buildFixture({
      deltaContent: `${DELTA_MODIFIED_ALL_SCENARIOS}\nExample: \`## Removed Scenarios\` belongs in proposal.md.\n\n\`\`\`\n## Removed Scenarios\n- "demo"\n\`\`\`\n`,
      canonicalContent: CANONICAL_WITH_TWO_SCENARIOS,
    });
    try {
      const result = lintModifiedScenarioPreservation({ changeFolder, repoRoot: root });
      assert.equal(result.pass, true, JSON.stringify(result));
      assert.equal((result.locationErrors ?? []).length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// --- CLI-level tests (spawn-based): exit code and stderr contract ---

describe('lint-modified-scenario-preservation CLI', () => {
  // CLI Case A: violation → exit 1 + stderr with required fragments
  test('CLI Case A: missing scenario → exit 1 + stderr Requirement + title + ## Removed Scenarios hint', () => {
    // Build fixture: canonical has 2 scenarios, delta MODIFIED has only 1
    const root = join(tmpdir(), `lint-msp-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const changeName = 'cli-test-change';
    const cap = 'cli-test-cap';
    const changeFolder = join(root, 'openspec', 'changes', changeName);
    const deltaSpecDir = join(changeFolder, 'specs', cap);
    const canonicalSpecDir = join(root, 'openspec', 'specs', cap);

    mkdirSync(deltaSpecDir, { recursive: true });
    mkdirSync(canonicalSpecDir, { recursive: true });

    writeFileSync(join(canonicalSpecDir, 'spec.md'), CANONICAL_WITH_TWO_SCENARIOS, 'utf8');
    writeFileSync(join(deltaSpecDir, 'spec.md'), DELTA_MODIFIED_MISSING_ONE, 'utf8');

    try {
      const r = spawnSync('node', [SCRIPT, changeFolder], { encoding: 'utf8' });
      assert.equal(r.status, 1, `expected exit 1 but got ${r.status}; stdout=${r.stdout}; stderr=${r.stderr}`);
      assert.match(r.stderr, /:: Requirement "/, 'stderr must contain :: Requirement "');
      assert.match(r.stderr, /Invalid Input/, 'stderr must contain the missing scenario title');
      assert.match(r.stderr, /## Removed Scenarios/, 'stderr must contain ## Removed Scenarios hint');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // CLI Case B: all scenarios preserved → exit 0 + stdout contains "pass"
  test('CLI Case B: all scenarios preserved → exit 0 + stdout contains pass', () => {
    const root = join(tmpdir(), `lint-msp-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const changeName = 'cli-test-change';
    const cap = 'cli-test-cap';
    const changeFolder = join(root, 'openspec', 'changes', changeName);
    const deltaSpecDir = join(changeFolder, 'specs', cap);
    const canonicalSpecDir = join(root, 'openspec', 'specs', cap);

    mkdirSync(deltaSpecDir, { recursive: true });
    mkdirSync(canonicalSpecDir, { recursive: true });

    writeFileSync(join(canonicalSpecDir, 'spec.md'), CANONICAL_WITH_TWO_SCENARIOS, 'utf8');
    writeFileSync(join(deltaSpecDir, 'spec.md'), DELTA_MODIFIED_ALL_SCENARIOS, 'utf8');

    try {
      const r = spawnSync('node', [SCRIPT, changeFolder], { encoding: 'utf8' });
      assert.equal(r.status, 0, `expected exit 0 but got ${r.status}; stdout=${r.stdout}; stderr=${r.stderr}`);
      assert.match(r.stdout, /pass/, 'stdout must contain "pass"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// --- #2978: base-aware comparison (--base <change-base-ref>) -----------------
//
// The default comparison reads the CURRENT canonical spec. Canonical and delta
// are required to land in the same final state, so renaming a scenario title on
// BOTH sides in one change leaves nothing to compare. With a change base ref the
// lint also expects every scenario the canonical Requirement had at that base.

function gitIn(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(
    result.status,
    0,
    `git ${args.join(' ')} failed: stdout=${result.stdout}; stderr=${result.stderr}`,
  );
  return result.stdout.trim();
}

/** Commit everything under root as the change base and return its sha. */
function commitChangeBase(root) {
  gitIn(root, ['init', '-q']);
  gitIn(root, ['config', 'user.email', 'lint-fixture@example.invalid']);
  gitIn(root, ['config', 'user.name', 'Lint Fixture']);
  gitIn(root, ['add', '.']);
  gitIn(root, ['commit', '-q', '-m', 'change base']);
  return gitIn(root, ['rev-parse', 'HEAD']);
}

function writeCanonical(root, content, cap = 'test-cap') {
  const dir = join(root, 'openspec', 'specs', cap);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'spec.md'), content, 'utf8');
}

const renameInvalidInput = text => text.replaceAll('Invalid Input', 'Rejected Input');

describe('lint-modified-scenario-preservation --base (#2978)', () => {
  test('two-sided rename: invisible without a base ref, a violation with one', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: DELTA_MODIFIED_ALL_SCENARIOS,
      canonicalContent: CANONICAL_WITH_TWO_SCENARIOS,
    });
    try {
      const baseRef = commitChangeBase(root);
      // The same change renames the scenario in the delta AND in canonical.
      writeFileSync(
        join(changeFolder, 'specs', 'test-cap', 'spec.md'),
        renameInvalidInput(DELTA_MODIFIED_ALL_SCENARIOS),
        'utf8',
      );
      writeCanonical(root, renameInvalidInput(CANONICAL_WITH_TWO_SCENARIOS));

      const legacy = lintModifiedScenarioPreservation({ changeFolder, repoRoot: root });
      assert.equal(legacy.pass, true, 'without a base ref the lint keeps its current-canonical behaviour');

      const result = lintModifiedScenarioPreservation({ changeFolder, repoRoot: root, baseRef });
      assert.equal(result.pass, false, 'with a base ref the renamed-away scenario must be reported');
      assert.equal(result.violations.length, 1);
      assert.equal(result.violations[0].cap, 'test-cap');
      assert.equal(result.violations[0].requirement, 'Widget Processing');
      assert.deepEqual(result.violations[0].missing, ['Scenario: Invalid Input']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('scenario dropped from delta and canonical together is also a violation', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: DELTA_MODIFIED_ALL_SCENARIOS,
      canonicalContent: CANONICAL_WITH_TWO_SCENARIOS,
    });
    try {
      const baseRef = commitChangeBase(root);
      writeFileSync(join(changeFolder, 'specs', 'test-cap', 'spec.md'), DELTA_MODIFIED_MISSING_ONE, 'utf8');
      writeCanonical(root, CANONICAL_WITH_TWO_SCENARIOS.replace(/#### Scenario: Invalid Input[\s\S]*$/u, ''));

      const result = lintModifiedScenarioPreservation({ changeFolder, repoRoot: root, baseRef });
      assert.equal(result.pass, false);
      assert.deepEqual(result.violations[0].missing, ['Scenario: Invalid Input']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a rename declared under ## Removed Scenarios in tasks.md passes', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: DELTA_MODIFIED_ALL_SCENARIOS,
      canonicalContent: CANONICAL_WITH_TWO_SCENARIOS,
    });
    try {
      const baseRef = commitChangeBase(root);
      writeFileSync(
        join(changeFolder, 'specs', 'test-cap', 'spec.md'),
        renameInvalidInput(DELTA_MODIFIED_ALL_SCENARIOS),
        'utf8',
      );
      writeFileSync(join(changeFolder, 'tasks.md'), '## Removed Scenarios\n- "Invalid Input"\n', 'utf8');
      writeCanonical(root, renameInvalidInput(CANONICAL_WITH_TWO_SCENARIOS));

      const result = lintModifiedScenarioPreservation({ changeFolder, repoRoot: root, baseRef });
      assert.equal(result.pass, true, `unexpected violations: ${JSON.stringify(result.violations)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('canonical unchanged since the base and delta preserving everything passes', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: DELTA_MODIFIED_ALL_SCENARIOS,
      canonicalContent: CANONICAL_WITH_TWO_SCENARIOS,
    });
    try {
      const baseRef = commitChangeBase(root);
      const result = lintModifiedScenarioPreservation({ changeFolder, repoRoot: root, baseRef });
      assert.equal(result.pass, true, `unexpected violations: ${JSON.stringify(result.violations)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a scenario added to canonical and delta together keeps passing', () => {
    const added = '#### Scenario: Retry\n- **WHEN** a widget is retried\n- **THEN** the system SHALL accept it\n\n';
    const { root, changeFolder } = buildFixture({
      deltaContent: DELTA_MODIFIED_ALL_SCENARIOS,
      canonicalContent: CANONICAL_WITH_TWO_SCENARIOS,
    });
    try {
      const baseRef = commitChangeBase(root);
      writeFileSync(
        join(changeFolder, 'specs', 'test-cap', 'spec.md'),
        `${DELTA_MODIFIED_ALL_SCENARIOS.trimEnd()}\n\n${added}`,
        'utf8',
      );
      writeCanonical(root, `${CANONICAL_WITH_TWO_SCENARIOS.trimEnd()}\n\n${added}`);

      const result = lintModifiedScenarioPreservation({ changeFolder, repoRoot: root, baseRef });
      assert.equal(result.pass, true, `unexpected violations: ${JSON.stringify(result.violations)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('requirements the delta does not MODIFY are not compared against the base', () => {
    const otherRequirement = '### Requirement: Other Processing\n\nThe system SHALL do other things.\n\n#### Scenario: Other Path\n- **WHEN** other\n- **THEN** the system SHALL cope\n\n';
    const { root, changeFolder } = buildFixture({
      deltaContent: DELTA_MODIFIED_ALL_SCENARIOS,
      canonicalContent: `${CANONICAL_WITH_TWO_SCENARIOS}${otherRequirement}`,
    });
    try {
      const baseRef = commitChangeBase(root);
      const result = lintModifiedScenarioPreservation({ changeFolder, repoRoot: root, baseRef });
      assert.equal(result.pass, true, `unexpected violations: ${JSON.stringify(result.violations)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a capability that has no canonical spec at the base does not fail', () => {
    const { root, changeFolder } = buildFixture({ deltaContent: DELTA_MODIFIED_ALL_SCENARIOS });
    try {
      const baseRef = commitChangeBase(root);
      writeCanonical(root, CANONICAL_WITH_TWO_SCENARIOS);
      const result = lintModifiedScenarioPreservation({ changeFolder, repoRoot: root, baseRef });
      assert.equal(result.pass, true, `unexpected violations: ${JSON.stringify(result.violations)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an unresolvable base ref fails closed with an error', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: DELTA_MODIFIED_ALL_SCENARIOS,
      canonicalContent: CANONICAL_WITH_TWO_SCENARIOS,
    });
    try {
      commitChangeBase(root);
      const result = lintModifiedScenarioPreservation({ changeFolder, repoRoot: root, baseRef: 'no-such-ref' });
      assert.equal(result.pass, false);
      assert.match(result.error, /invalid change base ref: no-such-ref/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('CLI --base reports the base-only scenario and names the base ref', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: DELTA_MODIFIED_ALL_SCENARIOS,
      canonicalContent: CANONICAL_WITH_TWO_SCENARIOS,
    });
    try {
      const baseRef = commitChangeBase(root);
      writeFileSync(
        join(changeFolder, 'specs', 'test-cap', 'spec.md'),
        renameInvalidInput(DELTA_MODIFIED_ALL_SCENARIOS),
        'utf8',
      );
      writeCanonical(root, renameInvalidInput(CANONICAL_WITH_TWO_SCENARIOS));

      const withBase = spawnSync('node', [SCRIPT, changeFolder, '--base', baseRef], { encoding: 'utf8' });
      assert.equal(withBase.status, 1, `stdout=${withBase.stdout}; stderr=${withBase.stderr}`);
      assert.match(withBase.stderr, /:: Requirement "Widget Processing" :: missing scenario "Invalid Input"/);
      assert.match(withBase.stderr, new RegExp(`present in canonical at ${baseRef}`));

      const withoutBase = spawnSync('node', [SCRIPT, changeFolder], { encoding: 'utf8' });
      assert.equal(withoutBase.status, 0, `the flag is optional: stderr=${withoutBase.stderr}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an empty or non-string base ref fails closed instead of taking the legacy path', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: DELTA_MODIFIED_ALL_SCENARIOS,
      canonicalContent: CANONICAL_WITH_TWO_SCENARIOS,
    });
    try {
      commitChangeBase(root);
      writeFileSync(
        join(changeFolder, 'specs', 'test-cap', 'spec.md'),
        renameInvalidInput(DELTA_MODIFIED_ALL_SCENARIOS),
        'utf8',
      );
      writeCanonical(root, renameInvalidInput(CANONICAL_WITH_TWO_SCENARIOS));
      for (const baseRef of ['', 0, false, {}]) {
        const result = lintModifiedScenarioPreservation({ changeFolder, repoRoot: root, baseRef });
        assert.equal(result.pass, false, `baseRef ${JSON.stringify(baseRef)} must not pass`);
        assert.match(result.error, /invalid change base ref/);
      }
      // null / undefined mean "no base supplied" and keep the legacy comparison.
      for (const baseRef of [undefined, null]) {
        assert.equal(lintModifiedScenarioPreservation({ changeFolder, repoRoot: root, baseRef }).pass, true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('CLI --base with an empty value exits 1 on the two-sided rename fixture', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: DELTA_MODIFIED_ALL_SCENARIOS,
      canonicalContent: CANONICAL_WITH_TWO_SCENARIOS,
    });
    try {
      commitChangeBase(root);
      writeFileSync(
        join(changeFolder, 'specs', 'test-cap', 'spec.md'),
        renameInvalidInput(DELTA_MODIFIED_ALL_SCENARIOS),
        'utf8',
      );
      writeCanonical(root, renameInvalidInput(CANONICAL_WITH_TWO_SCENARIOS));
      const empty = spawnSync('node', [SCRIPT, changeFolder, '--base', ''], { encoding: 'utf8' });
      assert.equal(empty.status, 1, `stdout=${empty.stdout}; stderr=${empty.stderr}`);
      assert.match(empty.stderr, /invalid change base ref/);
      const omitted = spawnSync('node', [SCRIPT, changeFolder], { encoding: 'utf8' });
      assert.equal(omitted.status, 0, `an omitted base keeps the legacy behaviour: stderr=${omitted.stderr}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('CLI rejects an incomplete or unknown argument', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: DELTA_MODIFIED_ALL_SCENARIOS,
      canonicalContent: CANONICAL_WITH_TWO_SCENARIOS,
    });
    try {
      for (const extra of [['--base'], ['--bogus']]) {
        const r = spawnSync('node', [SCRIPT, changeFolder, ...extra], { encoding: 'utf8' });
        assert.equal(r.status, 1, `${extra.join(' ')}: stdout=${r.stdout}; stderr=${r.stderr}`);
        assert.match(r.stderr, /unknown or incomplete argument/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// --- REMOVED Requirement scenario declaration + exact bare-title match -------
//
// Mirrors pre-pr-archive-gate.mjs gate (i): a scenario that exists in canonical
// before promotion and whose bare title is gone after promotion must be declared
// under `## Removed Scenarios` as the bare title (exact match, no `Scenario: `).

const OTHER_REQUIREMENT_SAME_TITLES = `### Requirement: Other Processing

The system SHALL do other things.

#### Scenario: Happy Path
- **WHEN** other happens
- **THEN** the system SHALL cope

#### Scenario: Invalid Input
- **WHEN** other fails
- **THEN** the system SHALL reject it

`;

const CANONICAL_TWO_REQUIREMENTS_SHARED_TITLES = `${CANONICAL_WITH_TWO_SCENARIOS}${OTHER_REQUIREMENT_SAME_TITLES}`;

const REMOVED_WIDGET_PROCESSING_BLOCK = `## REMOVED Requirements

### Requirement: Widget Processing

**Reason**: superseded.

#### Scenario: Happy Path
- **WHEN** a valid widget is submitted
- **THEN** the system SHALL accept it

#### Scenario: Invalid Input
- **WHEN** an invalid widget is submitted
- **THEN** the system SHALL reject it with code 400

`;

const DELTA_REMOVED_ONLY = `# test-cap Spec Delta

${REMOVED_WIDGET_PROCESSING_BLOCK}`;

const ADDED_WIDGET_INTAKE_BLOCK = `## ADDED Requirements

### Requirement: Widget Intake

The system SHALL intake widgets.

#### Scenario: Happy Path
- **WHEN** a valid widget is submitted
- **THEN** the system SHALL accept it

#### Scenario: Invalid Input
- **WHEN** an invalid widget is submitted
- **THEN** the system SHALL reject it with code 400

`;

const removedScenariosSection = lines => `## Removed Scenarios\n${lines.join('\n')}\n`;

describe('lint-modified-scenario-preservation REMOVED Requirement scenarios', () => {
  test('Removed Requirement Scenario Not Retained And Undeclared Is Blocked (REMOVED-only delta)', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: DELTA_REMOVED_ONLY,
      canonicalContent: CANONICAL_WITH_TWO_SCENARIOS,
    });
    try {
      const result = lintModifiedScenarioPreservation({ changeFolder, repoRoot: root });
      assert.equal(result.pass, false, 'a REMOVED-only delta must no longer skip the capability');
      assert.equal(result.violations.length, 1);
      const v = result.violations[0];
      assert.equal(v.cap, 'test-cap');
      assert.equal(v.requirement, 'Widget Processing');
      assert.deepEqual(v.removedUndeclared, ['Happy Path', 'Invalid Input']);
      assert.deepEqual(v.missing, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Removed Requirement Scenario Not Retained And Undeclared Is Blocked (CRLF delta)', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: toCrlf(DELTA_REMOVED_ONLY),
      canonicalContent: CANONICAL_WITH_TWO_SCENARIOS,
    });
    try {
      const result = lintModifiedScenarioPreservation({ changeFolder, repoRoot: root });
      assert.equal(result.pass, false);
      assert.deepEqual(result.violations[0].removedUndeclared, ['Happy Path', 'Invalid Input']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Removed Requirement Scenario Not Retained And Undeclared Is Blocked (CLI stderr + hint)', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: DELTA_REMOVED_ONLY,
      canonicalContent: CANONICAL_WITH_TWO_SCENARIOS,
    });
    try {
      const r = spawnSync('node', [SCRIPT, changeFolder], { encoding: 'utf8' });
      assert.equal(r.status, 1, `stdout=${r.stdout}; stderr=${r.stderr}`);
      assert.match(
        r.stderr,
        /\[lint-modified-scenario-preservation\] test-cap :: Requirement "Widget Processing" :: removed scenario "Happy Path" not declared\n/,
      );
      assert.match(r.stderr, /:: removed scenario "Invalid Input" not declared\n/);
      assert.match(r.stderr, /## Removed Scenarios/);
      assert.match(r.stderr, /bare title/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Removed Requirement Scenario Declared Or Retained Passes (declared: bare, quoted, backtick across carriers)', () => {
    const declarations = [
      { proposalMini: `# pm\n\n${removedScenariosSection(['- Happy Path', '- Invalid Input'])}\n## Tasks\n` },
      { tasks: `# Tasks\n\n${removedScenariosSection(['- "Happy Path"', '- "Invalid Input"'])}\n## Implementation\n` },
      { decisions: `# Decisions\n\n${removedScenariosSection(['- `Happy Path`', '- `Invalid Input`'])}\n## Other\n` },
    ];
    for (const carrier of declarations) {
      const { root, changeFolder } = buildFixture({
        deltaContent: DELTA_REMOVED_ONLY,
        canonicalContent: CANONICAL_WITH_TWO_SCENARIOS,
        ...carrier,
      });
      try {
        const result = lintModifiedScenarioPreservation({ changeFolder, repoRoot: root });
        assert.equal(result.pass, true, `${Object.keys(carrier)[0]}: ${JSON.stringify(result.violations)}`);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test('Removed Requirement Scenario Declared Or Retained Passes (declaring only one title still blocks the other)', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: DELTA_REMOVED_ONLY,
      canonicalContent: CANONICAL_WITH_TWO_SCENARIOS,
      tasks: `# Tasks\n\n${removedScenariosSection(['- "Happy Path"'])}`,
    });
    try {
      const result = lintModifiedScenarioPreservation({ changeFolder, repoRoot: root });
      assert.equal(result.pass, false);
      assert.deepEqual(result.violations[0].removedUndeclared, ['Invalid Input']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Removed Requirement Scenario Declared Or Retained Passes (moved into an ADDED Requirement)', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: `# test-cap Spec Delta\n\n${ADDED_WIDGET_INTAKE_BLOCK}${REMOVED_WIDGET_PROCESSING_BLOCK}`,
      canonicalContent: CANONICAL_WITH_TWO_SCENARIOS,
    });
    try {
      const result = lintModifiedScenarioPreservation({ changeFolder, repoRoot: root });
      assert.equal(result.pass, true, `unexpected violations: ${JSON.stringify(result.violations)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Removed Requirement Scenario Declared Or Retained Passes (moved into a MODIFIED Requirement, delta version used)', () => {
    const modifiedOther = `## MODIFIED Requirements

### Requirement: Other Processing

The system SHALL do other things (updated).

#### Scenario: Other Path
- **WHEN** other happens
- **THEN** the system SHALL cope

#### Scenario: Happy Path
- **WHEN** a valid widget is submitted
- **THEN** the system SHALL accept it

#### Scenario: Invalid Input
- **WHEN** an invalid widget is submitted
- **THEN** the system SHALL reject it with code 400

`;
    const canonical = `${CANONICAL_WITH_TWO_SCENARIOS}### Requirement: Other Processing

The system SHALL do other things.

#### Scenario: Other Path
- **WHEN** other happens
- **THEN** the system SHALL cope

`;
    const { root, changeFolder } = buildFixture({
      deltaContent: `# test-cap Spec Delta\n\n${modifiedOther}${REMOVED_WIDGET_PROCESSING_BLOCK}`,
      canonicalContent: canonical,
    });
    try {
      const result = lintModifiedScenarioPreservation({ changeFolder, repoRoot: root });
      assert.equal(result.pass, true, `unexpected violations: ${JSON.stringify(result.violations)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Removed Requirement Scenario Declared Or Retained Passes (same titles kept in an untouched canonical Requirement)', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: DELTA_REMOVED_ONLY,
      canonicalContent: CANONICAL_TWO_REQUIREMENTS_SHARED_TITLES,
    });
    try {
      const result = lintModifiedScenarioPreservation({ changeFolder, repoRoot: root });
      assert.equal(result.pass, true, `unexpected violations: ${JSON.stringify(result.violations)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Removed Requirement Scenario Not Retained And Undeclared Is Blocked (a canonical Requirement the delta also REMOVES does not retain)', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: `${DELTA_REMOVED_ONLY}${OTHER_REQUIREMENT_SAME_TITLES}`,
      canonicalContent: CANONICAL_TWO_REQUIREMENTS_SHARED_TITLES,
    });
    try {
      const result = lintModifiedScenarioPreservation({ changeFolder, repoRoot: root });
      assert.equal(result.pass, false);
      const names = result.violations.map(v => v.requirement).sort();
      assert.deepEqual(names, ['Other Processing', 'Widget Processing']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Removed Requirement Without Canonical Counterpart Skipped (name absent from canonical)', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: DELTA_REMOVED_ONLY.replace('Widget Processing', 'Never Existed'),
      canonicalContent: CANONICAL_WITH_TWO_SCENARIOS,
    });
    try {
      const result = lintModifiedScenarioPreservation({ changeFolder, repoRoot: root });
      assert.equal(result.pass, true, `unexpected violations: ${JSON.stringify(result.violations)}`);
      assert.equal(result.violations.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Removed Requirement Without Canonical Counterpart Skipped (capability has no canonical spec)', () => {
    const { root, changeFolder } = buildFixture({ deltaContent: DELTA_REMOVED_ONLY });
    try {
      const result = lintModifiedScenarioPreservation({ changeFolder, repoRoot: root });
      assert.equal(result.pass, true, `unexpected violations: ${JSON.stringify(result.violations)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Removed Requirement Without Canonical Counterpart Skipped (a name that exists only at the change base ref is still guarded)', () => {
    const unrelatedCanonical = CANONICAL_WITH_TWO_SCENARIOS
      .replace('Widget Processing', 'Gadget Handling')
      .replace('Happy Path', 'Gadget Works')
      .replace('Invalid Input', 'Gadget Breaks');
    const { root, changeFolder } = buildFixture({
      deltaContent: DELTA_REMOVED_ONLY,
      canonicalContent: CANONICAL_WITH_TWO_SCENARIOS,
    });
    try {
      const baseRef = commitChangeBase(root);
      writeCanonical(root, unrelatedCanonical);

      const withoutBase = lintModifiedScenarioPreservation({ changeFolder, repoRoot: root });
      assert.equal(withoutBase.pass, true, 'without a base ref the requirement has no counterpart anywhere');

      const withBase = lintModifiedScenarioPreservation({ changeFolder, repoRoot: root, baseRef });
      assert.equal(withBase.pass, false);
      assert.equal(withBase.violations.length, 1);
      assert.equal(withBase.violations[0].requirement, 'Widget Processing');
      assert.deepEqual([...withBase.violations[0].removedUndeclared].sort(), ['Happy Path', 'Invalid Input']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Prefixed Declaration Does Not Authorize (MODIFIED drop)', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: DELTA_MODIFIED_MISSING_ONE,
      canonicalContent: CANONICAL_WITH_TWO_SCENARIOS,
      tasks: `# Tasks\n\n${removedScenariosSection(['- "Scenario: Invalid Input"'])}`,
    });
    try {
      const result = lintModifiedScenarioPreservation({ changeFolder, repoRoot: root });
      assert.equal(result.pass, false, 'a `Scenario: ` prefixed declaration must not authorize');
      assert.deepEqual(result.violations[0].missing, ['Scenario: Invalid Input']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Prefixed Declaration Does Not Authorize (REMOVED scenario)', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: DELTA_REMOVED_ONLY,
      canonicalContent: CANONICAL_WITH_TWO_SCENARIOS,
      tasks: `# Tasks\n\n${removedScenariosSection(['- "Scenario: Happy Path"', '- Invalid Input'])}`,
    });
    try {
      const result = lintModifiedScenarioPreservation({ changeFolder, repoRoot: root });
      assert.equal(result.pass, false);
      assert.deepEqual(result.violations[0].removedUndeclared, ['Happy Path']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Prefixed Declaration Does Not Authorize (CLI tells the author to declare the bare title)', () => {
    for (const [deltaContent, tasksLine] of [
      [DELTA_MODIFIED_MISSING_ONE, '- "Scenario: Invalid Input"'],
      [DELTA_REMOVED_ONLY, '- "Scenario: Happy Path"'],
    ]) {
      const { root, changeFolder } = buildFixture({
        deltaContent,
        canonicalContent: CANONICAL_WITH_TWO_SCENARIOS,
        tasks: `# Tasks\n\n${removedScenariosSection([tasksLine])}`,
      });
      try {
        const r = spawnSync('node', [SCRIPT, changeFolder], { encoding: 'utf8' });
        assert.equal(r.status, 1, `stdout=${r.stdout}; stderr=${r.stderr}`);
        assert.match(r.stderr, /bare title/);
        assert.match(r.stderr, /`Scenario: ` prefix is NOT honored/);
        assert.match(r.stderr, /gate \(i\)/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test('Removed Requirement Scenario Dropped Earlier On The Branch Is Blocked', () => {
    const canonicalWithoutInvalid = CANONICAL_WITH_TWO_SCENARIOS.replace(/#### Scenario: Invalid Input[\s\S]*$/u, '');
    const { root, changeFolder } = buildFixture({
      deltaContent: `# test-cap Spec Delta\n\n${ADDED_WIDGET_INTAKE_BLOCK.replace(/#### Scenario: Invalid Input[\s\S]*$/u, '')}${REMOVED_WIDGET_PROCESSING_BLOCK.replace(/#### Scenario: Invalid Input[\s\S]*$/u, '')}`,
      canonicalContent: CANONICAL_WITH_TWO_SCENARIOS,
    });
    try {
      const baseRef = commitChangeBase(root);
      // Earlier on the branch canonical already dropped "Invalid Input"; the delta
      // REMOVED block copies the current (shorter) Requirement verbatim.
      writeCanonical(root, canonicalWithoutInvalid);

      const legacy = lintModifiedScenarioPreservation({ changeFolder, repoRoot: root });
      assert.equal(legacy.pass, true, 'without a base ref the dropped title is invisible');

      const result = lintModifiedScenarioPreservation({ changeFolder, repoRoot: root, baseRef });
      assert.equal(result.pass, false);
      assert.equal(result.violations.length, 1);
      assert.equal(result.violations[0].requirement, 'Widget Processing');
      assert.deepEqual(result.violations[0].removedUndeclared, ['Invalid Input']);
      assert.deepEqual(result.violations[0].fromBase, ['Invalid Input']);

      const cli = spawnSync('node', [SCRIPT, changeFolder, '--base', baseRef], { encoding: 'utf8' });
      assert.equal(cli.status, 1, `stdout=${cli.stdout}; stderr=${cli.stderr}`);
      assert.match(cli.stderr, /:: Requirement "Widget Processing" :: removed scenario "Invalid Input" not declared/);
      assert.match(cli.stderr, new RegExp(`present in canonical at ${baseRef}`));

      writeFileSync(
        join(changeFolder, 'tasks.md'),
        `# Tasks\n\n${removedScenariosSection(['- "Invalid Input"'])}`,
        'utf8',
      );
      const declared = lintModifiedScenarioPreservation({ changeFolder, repoRoot: root, baseRef });
      assert.equal(declared.pass, true, `unexpected violations: ${JSON.stringify(declared.violations)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
