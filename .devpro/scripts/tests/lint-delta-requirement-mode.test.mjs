import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lintDeltaRequirementMode } from '../lint-delta-requirement-mode.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'lint-delta-requirement-mode.mjs');

function toCrlf(text) {
  return text.replace(/\n/g, '\r\n');
}

function buildFixture({
  changeName = 'test-change',
  cap = 'test-cap',
  deltaContent,
  canonicalContent,
}) {
  const root = join(tmpdir(), `lint-drm-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

const CANONICAL = `# test-cap Specification

## Requirements

### Requirement: Existing Behavior

The system SHALL keep existing behavior.

#### Scenario: Existing Path
- **WHEN** existing behavior runs
- **THEN** the system SHALL preserve it

`;

const ADDED_EXISTING = `# test-cap Delta

## ADDED Requirements

### Requirement: Existing Behavior

The system SHALL add a scenario to existing behavior.

#### Scenario: New Path
- **WHEN** a new path runs
- **THEN** the system SHALL handle it

`;

const ADDED_NEW = `# test-cap Delta

## ADDED Requirements

### Requirement: Brand New Behavior

The system SHALL support brand new behavior.

#### Scenario: New Path
- **WHEN** brand new behavior runs
- **THEN** the system SHALL handle it

`;

const MODIFIED_EXISTING = `# test-cap Delta

## MODIFIED Requirements

### Requirement: Existing Behavior

The system SHALL keep existing behavior.

#### Scenario: Existing Path
- **WHEN** existing behavior runs
- **THEN** the system SHALL preserve it

#### Scenario: New Path
- **WHEN** a new path runs
- **THEN** the system SHALL handle it

`;

const MODIFIED_MISSING = `# test-cap Delta

## MODIFIED Requirements

### Requirement: Misspelled Behavior

The system SHALL keep behavior under a misspelled title.

#### Scenario: Any Path
- **WHEN** any path runs
- **THEN** the system SHALL handle it

`;

// Verbatim copy of CANONICAL's Existing Behavior block under REMOVED: what
// seal-final's derivePromotion requires (body exactly equal, scenarios included).
const REMOVED_VERBATIM = `# test-cap Delta

## REMOVED Requirements

### Requirement: Existing Behavior

The system SHALL keep existing behavior.

#### Scenario: Existing Path
- **WHEN** existing behavior runs
- **THEN** the system SHALL preserve it

`;

const REMOVED_REASON_SUMMARY = `# test-cap Delta

## REMOVED Requirements

### Requirement: Existing Behavior

**Reason**: the behavior is retired.
**Migration**: none.

`;

const REMOVED_MISSING_SCENARIO = `# test-cap Delta

## REMOVED Requirements

### Requirement: Existing Behavior

The system SHALL keep existing behavior.

`;

const REMOVED_MISSING_TITLE = `# test-cap Delta

## REMOVED Requirements

### Requirement: Misspelled Behavior

The system SHALL keep existing behavior.

#### Scenario: Existing Path
- **WHEN** existing behavior runs
- **THEN** the system SHALL preserve it

`;

// Whitespace-only departures from CANONICAL. derivePromotion compares with `!==`, so each
// of these is a failure at seal-final even though a reader sees the same text.
const REMOVED_REFLOWED = `# test-cap Delta

## REMOVED Requirements

### Requirement: Existing Behavior

The system SHALL keep
existing behavior.

#### Scenario: Existing Path
- **WHEN** existing behavior runs
- **THEN** the system SHALL preserve it

`;

// Built by replacement so the test file itself carries no trailing whitespace.
const REMOVED_TRAILING_SPACE = REMOVED_VERBATIM.replace(
  'The system SHALL keep existing behavior.\n',
  'The system SHALL keep existing behavior. \n',
);

const REMOVED_BLANK_LINE_DROPPED = `# test-cap Delta

## REMOVED Requirements

### Requirement: Existing Behavior

The system SHALL keep existing behavior.
#### Scenario: Existing Path
- **WHEN** existing behavior runs
- **THEN** the system SHALL preserve it

`;

// Built by replacement so the test file itself carries no trailing whitespace.
const REMOVED_TITLE_TRAILING_SPACE = REMOVED_VERBATIM.replace(
  '### Requirement: Existing Behavior\n',
  '### Requirement: Existing Behavior \n',
);

// A REMOVED section followed by a section heading that is not exact: parseRequirementBodies
// only changes the mode on the three exact headings, so the second requirement stays REMOVED.
const REMOVED_THEN_NONEXACT_HEADING = `# test-cap Delta

## REMOVED Requirements

### Requirement: Existing Behavior

The system SHALL keep existing behavior.

#### Scenario: Existing Path
- **WHEN** existing behavior runs
- **THEN** the system SHALL preserve it

## Removed Requirements

### Requirement: Other Behavior

**Reason**: the behavior is retired.
**Migration**: none.

`;

const CANONICAL_TWO_REQUIREMENTS = `# test-cap Specification

## Requirements

### Requirement: Existing Behavior

The system SHALL keep existing behavior.

#### Scenario: Existing Path
- **WHEN** existing behavior runs
- **THEN** the system SHALL preserve it

### Requirement: Other Behavior

The system SHALL keep other behavior.

#### Scenario: Other Path
- **WHEN** other behavior runs
- **THEN** the system SHALL preserve it

`;

// Multi-section deltas as retirement changes write them. The MODIFIED / ADDED block is
// deliberately NOT byte-equal to anything in canonical, and the REMOVED block is
// deliberately not verbatim, so a lint that mis-tracks the section mode changes the
// violation set: a REMOVED block skipped or read as MODIFIED reports nothing, and a
// MODIFIED / ADDED block read as REMOVED reports an extra removed-body-mismatch.
const MODIFIED_THEN_REMOVED = `# test-cap Delta

## MODIFIED Requirements

### Requirement: Other Behavior

The system SHALL keep other behavior.

#### Scenario: Other Path
- **WHEN** other behavior runs
- **THEN** the system SHALL preserve it

#### Scenario: Other New Path
- **WHEN** another path runs
- **THEN** the system SHALL handle it

## REMOVED Requirements

### Requirement: Existing Behavior

**Reason**: the behavior is retired.
**Migration**: none.

`;

const ADDED_THEN_REMOVED = `# test-cap Delta

## ADDED Requirements

### Requirement: Retired Behavior Tombstone

The system SHALL record that existing behavior is retired.

#### Scenario: Tombstone Path
- **WHEN** a reader looks up retired behavior
- **THEN** the system SHALL point at the tombstone

## REMOVED Requirements

### Requirement: Existing Behavior

**Reason**: the behavior is retired.
**Migration**: none.

`;

describe('lint-delta-requirement-mode', () => {
  test('ADDED requirement title that already exists in canonical spec fails', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: ADDED_EXISTING,
      canonicalContent: CANONICAL,
    });
    try {
      const result = lintDeltaRequirementMode({ changeFolder, repoRoot: root });
      assert.equal(result.pass, false);
      assert.equal(result.violations.length, 1);
      assert.equal(result.violations[0].mode, 'ADDED');
      assert.equal(result.violations[0].requirement, 'Existing Behavior');
      assert.equal(result.violations[0].reason, 'added-existing-requirement');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('CRLF ADDED requirement title that already exists still fails', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: toCrlf(ADDED_EXISTING),
      canonicalContent: CANONICAL,
    });
    try {
      const result = lintDeltaRequirementMode({ changeFolder, repoRoot: root });
      assert.equal(result.pass, false);
      assert.equal(result.violations[0].reason, 'added-existing-requirement');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('MODIFIED requirement title missing from existing canonical spec fails', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: MODIFIED_MISSING,
      canonicalContent: CANONICAL,
    });
    try {
      const result = lintDeltaRequirementMode({ changeFolder, repoRoot: root });
      assert.equal(result.pass, false);
      assert.equal(result.violations.length, 1);
      assert.equal(result.violations[0].mode, 'MODIFIED');
      assert.equal(result.violations[0].requirement, 'Misspelled Behavior');
      assert.equal(result.violations[0].reason, 'modified-missing-requirement');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('MODIFIED requirement in a new capability without canonical spec fails', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: MODIFIED_MISSING,
    });
    try {
      const result = lintDeltaRequirementMode({ changeFolder, repoRoot: root });
      assert.equal(result.pass, false);
      assert.equal(result.violations.length, 1);
      assert.equal(result.violations[0].reason, 'modified-missing-capability');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('ADDED new requirement in an existing canonical spec passes', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: ADDED_NEW,
      canonicalContent: CANONICAL,
    });
    try {
      const result = lintDeltaRequirementMode({ changeFolder, repoRoot: root });
      assert.equal(result.pass, true, `unexpected violations: ${JSON.stringify(result.violations)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('MODIFIED existing requirement passes', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: MODIFIED_EXISTING,
      canonicalContent: CANONICAL,
    });
    try {
      const result = lintDeltaRequirementMode({ changeFolder, repoRoot: root });
      assert.equal(result.pass, true, `unexpected violations: ${JSON.stringify(result.violations)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('ADDED requirement in a new capability passes', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: ADDED_NEW,
    });
    try {
      const result = lintDeltaRequirementMode({ changeFolder, repoRoot: root });
      assert.equal(result.pass, true, `unexpected violations: ${JSON.stringify(result.violations)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('CLI prints actionable guidance for ADDED existing requirement', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: ADDED_EXISTING,
      canonicalContent: CANONICAL,
    });
    try {
      const result = spawnSync('node', [SCRIPT, changeFolder], { encoding: 'utf8' });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /ADDED Requirement "Existing Behavior" already exists/);
      assert.match(result.stderr, /Adding a scenario to an existing requirement\nis MODIFIED, not ADDED/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('REMOVED requirement whose body is verbatim canonical passes', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: REMOVED_VERBATIM,
      canonicalContent: CANONICAL,
    });
    try {
      const result = lintDeltaRequirementMode({ changeFolder, repoRoot: root });
      assert.equal(result.pass, true, `unexpected violations: ${JSON.stringify(result.violations)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('REMOVED verbatim block passes with CRLF in the delta or in canonical', () => {
    for (const [deltaContent, canonicalContent] of [
      [toCrlf(REMOVED_VERBATIM), CANONICAL],
      [REMOVED_VERBATIM, toCrlf(CANONICAL)],
    ]) {
      const { root, changeFolder } = buildFixture({ deltaContent, canonicalContent });
      try {
        const result = lintDeltaRequirementMode({ changeFolder, repoRoot: root });
        assert.equal(result.pass, true, `unexpected violations: ${JSON.stringify(result.violations)}`);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test('REMOVED requirement with a Reason/Migration summary body fails as removed-body-mismatch', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: REMOVED_REASON_SUMMARY,
      canonicalContent: CANONICAL,
    });
    try {
      const result = lintDeltaRequirementMode({ changeFolder, repoRoot: root });
      assert.equal(result.pass, false);
      assert.equal(result.violations.length, 1);
      assert.equal(result.violations[0].mode, 'REMOVED');
      assert.equal(result.violations[0].requirement, 'Existing Behavior');
      assert.equal(result.violations[0].reason, 'removed-body-mismatch');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('REMOVED requirement that drops a canonical scenario fails as removed-body-mismatch', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: REMOVED_MISSING_SCENARIO,
      canonicalContent: CANONICAL,
    });
    try {
      const result = lintDeltaRequirementMode({ changeFolder, repoRoot: root });
      assert.equal(result.pass, false);
      assert.equal(result.violations.length, 1);
      assert.equal(result.violations[0].reason, 'removed-body-mismatch');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('REMOVED body differing from canonical only in whitespace fails as removed-body-mismatch', () => {
    for (const [name, deltaContent] of [
      ['reflowed sentence', REMOVED_REFLOWED],
      ['trailing space', REMOVED_TRAILING_SPACE],
      ['dropped blank line', REMOVED_BLANK_LINE_DROPPED],
    ]) {
      const { root, changeFolder } = buildFixture({ deltaContent, canonicalContent: CANONICAL });
      try {
        const result = lintDeltaRequirementMode({ changeFolder, repoRoot: root });
        assert.equal(result.pass, false, `${name}: expected a violation`);
        assert.equal(result.violations.length, 1, `${name}: ${JSON.stringify(result.violations)}`);
        assert.equal(result.violations[0].reason, 'removed-body-mismatch', name);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test('REMOVED title is compared exactly, so a title with trailing space is absent from canonical', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: REMOVED_TITLE_TRAILING_SPACE,
      canonicalContent: CANONICAL,
    });
    try {
      const result = lintDeltaRequirementMode({ changeFolder, repoRoot: root });
      assert.equal(result.pass, false);
      assert.equal(result.violations.length, 1, JSON.stringify(result.violations));
      assert.equal(result.violations[0].reason, 'removed-missing-requirement');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a non-exact heading as the first section does not start a REMOVED section', () => {
    // Same exact-heading rule as parseRequirementBodies. These headings are not REMOVED
    // sections, so the non-verbatim block under them is not compared. (core rejects such a
    // requirement through its "not under any mode heading" parser check, the known gap in
    // proposal-mini; revisit this test if that gap is closed.)
    for (const heading of ['## Removed Requirements', '## REMOVED Requirements (retired)']) {
      const deltaContent = REMOVED_REASON_SUMMARY.replace('## REMOVED Requirements', heading);
      const { root, changeFolder } = buildFixture({ deltaContent, canonicalContent: CANONICAL });
      try {
        const result = lintDeltaRequirementMode({ changeFolder, repoRoot: root });
        assert.equal(result.pass, true, `${heading}: ${JSON.stringify(result.violations)}`);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test('a non-exact heading after a REMOVED section keeps the REMOVED mode', () => {
    // The mode only changes on the three exact headings, so Other Behavior is still REMOVED
    // here and its non-verbatim body is a mismatch. This test fails under two mutations: a
    // case-insensitive heading match that leaves the mode in mixed case ('Removed', so the
    // block is skipped), and a non-exact `## ` heading that clears the mode. The first-section
    // test above is the one that fails when the heading match accepts trailing text, or is
    // case-insensitive and uppercases the mode.
    for (const heading of ['## Removed Requirements', '## REMOVED Requirements (retired)']) {
      const deltaContent = REMOVED_THEN_NONEXACT_HEADING.replace('## Removed Requirements', heading);
      const { root, changeFolder } = buildFixture({ deltaContent, canonicalContent: CANONICAL_TWO_REQUIREMENTS });
      try {
        const result = lintDeltaRequirementMode({ changeFolder, repoRoot: root });
        assert.equal(result.pass, false, heading);
        assert.equal(result.violations.length, 1, `${heading}: ${JSON.stringify(result.violations)}`);
        assert.equal(result.violations[0].mode, 'REMOVED');
        assert.equal(result.violations[0].requirement, 'Other Behavior');
        assert.equal(result.violations[0].reason, 'removed-body-mismatch');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test('REMOVED block in a delta that starts with a BOM is still checked', () => {
    // core reads the delta with a TextDecoder that drops the BOM, so seal-final sees the
    // section heading; a lint that keeps the BOM would not see it and would pass silently.
    // The BOM only precedes the first line, so that line must be the section heading.
    const withoutTitle = (text) => text.replace('# test-cap Delta\n\n', '');
    for (const [deltaContent, expectedPass] of [
      [`\uFEFF${withoutTitle(REMOVED_REASON_SUMMARY)}`, false],
      [`\uFEFF${withoutTitle(REMOVED_VERBATIM)}`, true],
    ]) {
      const { root, changeFolder } = buildFixture({ deltaContent, canonicalContent: CANONICAL });
      try {
        const result = lintDeltaRequirementMode({ changeFolder, repoRoot: root });
        assert.equal(result.pass, expectedPass, JSON.stringify(result.violations));
        if (!expectedPass) {
          assert.equal(result.violations.length, 1);
          assert.equal(result.violations[0].reason, 'removed-body-mismatch');
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test('REMOVED mismatch names the first differing body line', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: REMOVED_MISSING_SCENARIO,
      canonicalContent: CANONICAL,
    });
    try {
      const result = lintDeltaRequirementMode({ changeFolder, repoRoot: root });
      // Body line 1 is the shared SHALL sentence. The delta body ends there (trailing
      // blank lines are trimmed), so line 2, the blank line canonical continues with,
      // is the first difference.
      assert.equal(result.violations[0].line, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('REMOVED requirement title absent from canonical fails as removed-missing-requirement', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: REMOVED_MISSING_TITLE,
      canonicalContent: CANONICAL,
    });
    try {
      const result = lintDeltaRequirementMode({ changeFolder, repoRoot: root });
      assert.equal(result.pass, false);
      assert.equal(result.violations.length, 1);
      assert.equal(result.violations[0].requirement, 'Misspelled Behavior');
      assert.equal(result.violations[0].reason, 'removed-missing-requirement');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('REMOVED requirement in a capability without canonical spec fails as removed-missing-capability', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: REMOVED_VERBATIM,
    });
    try {
      const result = lintDeltaRequirementMode({ changeFolder, repoRoot: root });
      assert.equal(result.pass, false);
      assert.equal(result.violations.length, 1);
      assert.equal(result.violations[0].reason, 'removed-missing-capability');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('REMOVED check follows the delta mode after a MODIFIED block', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: MODIFIED_THEN_REMOVED,
      canonicalContent: CANONICAL_TWO_REQUIREMENTS,
    });
    try {
      const result = lintDeltaRequirementMode({ changeFolder, repoRoot: root });
      // Exactly the REMOVED violation: a REMOVED block that is skipped gives none, and the
      // MODIFIED block (which differs from canonical) read as REMOVED gives a second one.
      assert.equal(result.pass, false);
      assert.equal(result.violations.length, 1, JSON.stringify(result.violations));
      assert.equal(result.violations[0].mode, 'REMOVED');
      assert.equal(result.violations[0].requirement, 'Existing Behavior');
      assert.equal(result.violations[0].reason, 'removed-body-mismatch');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('REMOVED check follows the delta mode after an ADDED tombstone block', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: ADDED_THEN_REMOVED,
      canonicalContent: CANONICAL,
    });
    try {
      const result = lintDeltaRequirementMode({ changeFolder, repoRoot: root });
      assert.equal(result.pass, false);
      assert.equal(result.violations.length, 1, JSON.stringify(result.violations));
      assert.equal(result.violations[0].mode, 'REMOVED');
      assert.equal(result.violations[0].requirement, 'Existing Behavior');
      assert.equal(result.violations[0].reason, 'removed-body-mismatch');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('CLI prints guidance to copy the complete canonical block for a REMOVED mismatch', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: REMOVED_REASON_SUMMARY,
      canonicalContent: CANONICAL,
    });
    try {
      const result = spawnSync('node', [SCRIPT, changeFolder], { encoding: 'utf8' });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /REMOVED Requirement "Existing Behavior" body is not verbatim equal to the canonical body/);
      assert.match(result.stderr, /Copy the complete canonical requirement block/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('CLI names a REMOVED title that is absent from canonical and points at the copy fix', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: REMOVED_MISSING_TITLE,
      canonicalContent: CANONICAL,
    });
    try {
      const result = spawnSync('node', [SCRIPT, changeFolder], { encoding: 'utf8' });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /REMOVED Requirement "Misspelled Behavior" does not exist in canonical spec/);
      assert.match(result.stderr, /restore it from the immutable change base/);
      assert.match(result.stderr, /Fix \(REMOVED\)/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('CLI tells a REMOVED block with no canonical capability to fix the folder name, not to copy', () => {
    const { root, changeFolder } = buildFixture({
      deltaContent: REMOVED_VERBATIM,
    });
    try {
      const result = spawnSync('node', [SCRIPT, changeFolder], { encoding: 'utf8' });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /REMOVED Requirement "Existing Behavior" has no canonical capability spec/);
      assert.match(result.stderr, /correct the capability folder name/);
      // The shared copy-from-canonical recipe names a file that does not exist here.
      assert.doesNotMatch(result.stderr, /Copy the complete canonical requirement block/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
