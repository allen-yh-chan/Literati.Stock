import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, win32 } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeChangeTarget, openspecValidateSpawnOptions, assertWin32OpenspecSpawnArgs, stripRemovedScenariosFromTempCanonicalSpecs, copyTreeAsRegularFiles } from '../validate-openspec-change.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(scriptDir, '..', 'validate-openspec-change.mjs');

const PROPOSAL_MINI = `---
risk_classes: none
rationale: validate-openspec-change wrapper fixture (no auth/state/write/disclosure surface)
---

## Why

Validate B-mini active changes.

## What Changes

- Add a proposal-mini validation shim.

## Target State

- Active B-mini changes validate without adding proposal.md to the worktree.

## Touch

| 檔案 | 類別 | 動作 | Requirement |
|---|---|---|---|
| \`src/review-target.mjs\` | code | modify | R1 |

## Tasks

- [x] [Req: R1] Validate active B-mini fixture.
`;

const CANONICAL = `# demo Specification

## Purpose

Demo fixture.

## Requirements
### Requirement: Widget Processing

The system SHALL process widgets.

#### Scenario: Happy Path
- **WHEN** a valid widget is submitted
- **THEN** the system SHALL accept it

#### Scenario: Invalid Input
- **WHEN** an invalid widget is submitted
- **THEN** the system SHALL reject it
`;

const DELTA_PRESERVES_SCENARIOS = `# demo Spec Delta

## MODIFIED Requirements

### Requirement: Widget Processing

The system SHALL process widgets with updated wording.

#### Scenario: Happy Path
- **WHEN** a valid widget is submitted
- **THEN** the system SHALL accept it

#### Scenario: Invalid Input
- **WHEN** an invalid widget is submitted
- **THEN** the system SHALL reject it
`;

const DELTA_DROPS_SCENARIO = `# demo Spec Delta

## MODIFIED Requirements

### Requirement: Widget Processing

The system SHALL process widgets with updated wording.

#### Scenario: Happy Path
- **WHEN** a valid widget is submitted
- **THEN** the system SHALL accept it
`;

// #1968 shape: MODIFIED lists only a newly added scenario (wipes both siblings).
const DELTA_NEW_SCENARIO_ONLY_WIPE = `# demo Spec Delta

## MODIFIED Requirements

### Requirement: Widget Processing

The system SHALL process widgets with updated wording.

#### Scenario: Brand New Path
- **WHEN** a novel widget is submitted
- **THEN** the system SHALL accept the novel path
`;

const DELTA_RESTATE_WITH_NEW = `# demo Spec Delta

## MODIFIED Requirements

### Requirement: Widget Processing

The system SHALL process widgets with updated wording.

#### Scenario: Happy Path
- **WHEN** a valid widget is submitted
- **THEN** the system SHALL accept it

#### Scenario: Invalid Input
- **WHEN** an invalid widget is submitted
- **THEN** the system SHALL reject it

#### Scenario: Brand New Path
- **WHEN** a novel widget is submitted
- **THEN** the system SHALL accept the novel path
`;

// Contiguous additive: keep every canonical segment in order; insert new scenario.
const DELTA_CONTIGUOUS_ADDITIVE = `# demo Spec Delta

## MODIFIED Requirements

### Requirement: Widget Processing

The system SHALL process widgets.

#### Scenario: Happy Path
- **WHEN** a valid widget is submitted
- **THEN** the system SHALL accept it

#### Scenario: Brand New Path
- **WHEN** a novel widget is submitted
- **THEN** the system SHALL accept the novel path

#### Scenario: Invalid Input
- **WHEN** an invalid widget is submitted
- **THEN** the system SHALL reject it
`;

const FULL_PROPOSAL = `---
risk_classes: [state/invariant, write]
---

# Proposal: fixture

## Capabilities

### Modified Capabilities

- \`demo\`: exact compiler fixture.

## Section 1: Target State (Done When)

1. Preserve the exact review authority.

## Section 2: Touch

| 檔案 | 類別 | 動作 | Requirement |
|---|---|---|---|
| \`src/review-target.mjs\` | code | modify | R1 |

不動清單：

- \`src/second-target.mjs\`

## Section 3: Tasks

1. Prove the fixture.

## Consequence Assessment

| Dimension | Consequence |
|---|---|
| Security/trust/privacy/data | Fail closed before dispatch. |
| Material negatives/non-goals | Do not accept caller-provided authority. |

## Risk Classes and Material Negatives

- \`state/invariant\`: dispatch authority must be reproducible.
- \`write\`: receipt publication is durable.

## Migration Notes

migration note v1
`;

const FULL_TASKS = `# Tasks

## Tasks

- [x] [Req: R1] Validate full proposal fixture.
  驗收: wrapper exercised for full proposal.md
`;

const FULL_DESIGN = `# Design: fixture

## Context

Wrapper fixture design stub.

## Decisions

### D1 — Exact authority

Derive authority from exact selected sections.

### D2 — Durable binding

Bind the logical dispatch to current Git state.
`;

function buildFixture({
  changeName = 'mini-change',
  changePath = changeName,
  delta = DELTA_PRESERVES_SCENARIOS,
  mode = 'mini',
  removedScenarios,
} = {}) {
  const root = join(tmpdir(), `validate-openspec-change-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const changeFolder = join(root, 'openspec', 'changes', ...changePath.split('/'));
  mkdirSync(join(changeFolder, 'specs', 'demo'), { recursive: true });
  mkdirSync(join(root, 'openspec', 'specs', 'demo'), { recursive: true });
  mkdirSync(join(root, '.devpro', 'scripts', 'tests'), { recursive: true });

  if (mode === 'full') {
    let proposal = FULL_PROPOSAL;
    if (removedScenarios) {
      proposal += `\n## Removed Scenarios\n${removedScenarios}\n`;
    }
    writeFileSync(join(changeFolder, 'proposal.md'), proposal, 'utf8');
    writeFileSync(join(changeFolder, 'tasks.md'), FULL_TASKS, 'utf8');
    writeFileSync(join(changeFolder, 'design.md'), FULL_DESIGN, 'utf8');
  } else {
    writeFileSync(join(changeFolder, 'proposal-mini.md'), PROPOSAL_MINI, 'utf8');
  }
  writeFileSync(join(changeFolder, 'specs', 'demo', 'spec.md'), delta, 'utf8');
  writeFileSync(join(root, 'openspec', 'specs', 'demo', 'spec.md'), CANONICAL, 'utf8');
  // Asserting carrier so --strict new-scenario coverage lint can pass for fixture deltas.
  writeFileSync(
    join(root, '.devpro', 'scripts', 'tests', 'fixture-delta-assert.mjs'),
    `/* fixture asserting carrier for delta scenario titles\n${delta}\n*/\nexport {};\n`,
    'utf8',
  );

  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'test']);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'fixture']);
  const tip = git(root, ['rev-parse', 'HEAD']).trim();
  git(root, ['update-ref', 'refs/remotes/origin/main', tip]);

  return { root, changeFolder, changeName, changePath };
}

test('validates proposal-mini-only active B-mini change without writing proposal.md', () => {
  const { root, changeFolder, changeName } = buildFixture();
  try {
    const result = spawnSync('node', [SCRIPT, changeName, '--strict', '--json'], {
      cwd: root,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.summary.totals.passed, 1);
    assert.equal(parsed.items[0].id, changeName);
    assert.equal(existsSync(join(changeFolder, 'proposal.md')), false, 'wrapper must not leave proposal.md in active folder');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runs scenario-preservation lint after proposal-mini shim validation', () => {
  const { root, changeName } = buildFixture({ changeName: 'mini-drops-scenario', delta: DELTA_DROPS_SCENARIO });
  try {
    const result = spawnSync('node', [SCRIPT, changeName, '--strict'], {
      cwd: root,
      encoding: 'utf8',
    });

    assert.notEqual(result.status, 0, 'scenario-preservation violation must fail the wrapper');
    assert.match(result.stderr, /missing scenario "Invalid Input"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('full proposal.md wipe (#1968 shape) fails wrapper via scenario-preservation lint', () => {
  const { root, changeName, changeFolder } = buildFixture({
    changeName: 'full-wipe-new-scenario-only',
    delta: DELTA_NEW_SCENARIO_ONLY_WIPE,
    mode: 'full',
  });
  try {
    assert.equal(existsSync(join(changeFolder, 'proposal.md')), true);
    assert.equal(existsSync(join(changeFolder, 'proposal-mini.md')), false);
    const result = spawnSync('node', [SCRIPT, changeName, '--strict'], {
      cwd: root,
      encoding: 'utf8',
    });

    assert.notEqual(
      result.status,
      0,
      'full proposal.md sibling wipe must fail the wrapper (must not skip lint when hasProposalMini is false);\n' +
        `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(result.stderr, /missing scenario "Happy Path"/);
    assert.match(result.stderr, /missing scenario "Invalid Input"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('full proposal.md with restated scenarios plus new scenario passes wrapper', () => {
  const { root, changeName } = buildFixture({
    changeName: 'full-restate-with-new',
    delta: DELTA_RESTATE_WITH_NEW,
    mode: 'full',
  });
  try {
    const result = spawnSync('node', [SCRIPT, changeName, '--strict'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('full proposal.md contiguous additive insert passes wrapper', () => {
  const { root, changeName } = buildFixture({
    changeName: 'full-contiguous-additive',
    delta: DELTA_CONTIGUOUS_ADDITIVE,
    mode: 'full',
  });
  try {
    const result = spawnSync('node', [SCRIPT, changeName, '--strict'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('full proposal.md Removed Scenarios authorizes intentional drop', () => {
  const { root, changeName } = buildFixture({
    changeName: 'full-removed-scenarios',
    delta: DELTA_DROPS_SCENARIO,
    mode: 'full',
    removedScenarios: '- "Invalid Input"',
  });
  try {
    const result = spawnSync('node', [SCRIPT, changeName, '--strict'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('adversarial canonical symlink does not mutate sentinel outside temp', () => {
  const { root, changeName } = buildFixture({
    changeName: 'symlink-canonical-strip',
    delta: DELTA_DROPS_SCENARIO,
    mode: 'full',
    removedScenarios: '- "Invalid Input"',
  });
  try {
    const canonicalPath = join(root, 'openspec', 'specs', 'demo', 'spec.md');
    const sentinelDir = join(root, 'outside-sentinel');
    mkdirSync(sentinelDir, { recursive: true });
    const sentinelPath = join(sentinelDir, 'sentinel-spec.md');
    const originalBytes = readFileSync(canonicalPath);
    writeFileSync(sentinelPath, originalBytes);
    rmSync(canonicalPath);
    symlinkSync(sentinelPath, canonicalPath);

    const before = readFileSync(sentinelPath);
    const result = spawnSync('node', [SCRIPT, changeName, '--strict'], {
      cwd: root,
      encoding: 'utf8',
    });
    const after = readFileSync(sentinelPath);

    assert.equal(
      Buffer.compare(before, after),
      0,
      'sentinel outside temp must be unchanged (no symlink write-through)',
    );
    // Materialize path turns source symlink into a regular temp file → strip may succeed (0).
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stripRemovedScenariosFromTempCanonicalSpecs refuses retained symlink (D2a)', () => {
  const tempRoot = join(tmpdir(), `strip-symlink-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const specsDir = join(tempRoot, 'openspec', 'specs', 'demo');
  mkdirSync(specsDir, { recursive: true });
  const sentinelDir = join(tempRoot, '..', `strip-sentinel-${Date.now()}`);
  mkdirSync(sentinelDir, { recursive: true });
  const sentinelPath = join(sentinelDir, 'sentinel.md');
  const body = CANONICAL;
  writeFileSync(sentinelPath, body);
  const before = readFileSync(sentinelPath);
  symlinkSync(sentinelPath, join(specsDir, 'spec.md'));

  const result = stripRemovedScenariosFromTempCanonicalSpecs(tempRoot, new Set(['Invalid Input']));
  const after = readFileSync(sentinelPath);

  assert.equal(result.ok, false);
  assert.match(result.error, /retained a symlink|refusing strip write-through/i);
  assert.equal(Buffer.compare(before, after), 0, 'sentinel must be unchanged when strip refuses symlink');

  rmSync(tempRoot, { recursive: true, force: true });
  rmSync(sentinelDir, { recursive: true, force: true });
});

test('stripRemovedScenariosFromTempCanonicalSpecs strips declared scenario from regular files', () => {
  const tempRoot = join(tmpdir(), `strip-ok-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const specsDir = join(tempRoot, 'openspec', 'specs', 'demo');
  mkdirSync(specsDir, { recursive: true });
  const specPath = join(specsDir, 'spec.md');
  writeFileSync(specPath, CANONICAL);

  const result = stripRemovedScenariosFromTempCanonicalSpecs(tempRoot, new Set(['Invalid Input']));
  assert.equal(result.ok, true, result.error);
  const next = readFileSync(specPath, 'utf8');
  assert.match(next, /Scenario: Happy Path/);
  assert.doesNotMatch(next, /Scenario: Invalid Input/);

  rmSync(tempRoot, { recursive: true, force: true });
});

test('copyTreeAsRegularFiles refuses directory symlink (D2a Important)', () => {
  const srcRoot = join(tmpdir(), `copy-dirlink-src-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const destRoot = join(tmpdir(), `copy-dirlink-dest-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const outsideDir = join(tmpdir(), `copy-dirlink-outside-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    mkdirSync(join(srcRoot, 'openspec', 'specs'), { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, 'secret.md'), 'host-tree\n');
    symlinkSync(outsideDir, join(srcRoot, 'openspec', 'specs', 'demo'));

    assert.throws(
      () => copyTreeAsRegularFiles(join(srcRoot, 'openspec'), join(destRoot, 'openspec')),
      /directory symlink refused/,
    );
    assert.equal(existsSync(join(destRoot, 'openspec', 'specs', 'demo', 'secret.md')), false);
  } finally {
    rmSync(srcRoot, { recursive: true, force: true });
    rmSync(destRoot, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('rejects targets outside openspec changes', () => {
  const { root } = buildFixture();
  try {
    const outsideFolder = join(root, 'outside-change');
    mkdirSync(outsideFolder, { recursive: true });
    const result = spawnSync('node', [SCRIPT, outsideFolder, '--strict'], {
      cwd: root,
      encoding: 'utf8',
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /target must resolve under/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a change-folder symlink that escapes openspec changes', () => {
  const { root } = buildFixture();
  try {
    const outsideFolder = join(root, 'outside-symlink-target');
    const link = join(root, 'openspec', 'changes', 'escaped-link');
    mkdirSync(outsideFolder, { recursive: true });
    symlinkSync(outsideFolder, link, process.platform === 'win32' ? 'junction' : 'dir');

    const result = spawnSync('node', [SCRIPT, 'escaped-link', '--strict'], {
      cwd: root,
      encoding: 'utf8',
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /target must resolve under/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const [label, target, expectedRelPath] of [
  ['change name', 'active-change', 'active-change'],
  ['archive shorthand', 'archive\\2026-07-17-archived-change\\', 'archive/2026-07-17-archived-change'],
  ['full relative path', 'openspec\\changes\\active-change', 'active-change'],
  ['absolute path', 'C:\\repo\\openspec\\changes\\active-change\\', 'active-change'],
]) {
  test(`resolves native Windows ${label}`, () => {
    const resolved = normalizeChangeTarget('C:\\repo', target, { pathApi: win32 });
    assert.equal(resolved.error, undefined);
    assert.equal(resolved.changeRelPath, expectedRelPath);
    assert.equal(resolved.changeName, expectedRelPath.split('/').at(-1));
    assert.equal(resolved.isArchived, expectedRelPath.startsWith('archive/'));
  });
}

for (const [label, target] of [
  ['changes root', 'C:\\repo\\openspec\\changes\\'],
  ['archive root', 'archive\\'],
  ['parent traversal', 'openspec\\changes\\..\\outside'],
  ['absolute outside path', 'C:\\outside\\change'],
]) {
  test(`rejects native Windows ${label}`, () => {
    const resolved = normalizeChangeTarget('C:\\repo', target, { pathApi: win32 });
    assert.match(resolved.error, /target must (resolve under|identify a change folder under)/);
  });
}

for (const [label, targetFor] of [
  ['archive shorthand', ({ archiveName }) => `archive/${archiveName}`],
  ['full archive path', ({ archiveName }) => `openspec/changes/archive/${archiveName}`],
  ['absolute archive path', ({ root, archiveName }) => join(root, 'openspec', 'changes', 'archive', archiveName)],
]) {
  test(`validates proposal-mini-only archived B-mini change from ${label}`, () => {
    const archiveName = `2026-07-14-${label.replaceAll(' ', '-')}-mini-change`;
    const { root, changeFolder } = buildFixture({
      changeName: archiveName,
      changePath: `archive/${archiveName}`,
    });
    try {
      const result = spawnSync('node', [SCRIPT, targetFor({ root, archiveName }), '--strict', '--json'], {
        cwd: root,
        encoding: 'utf8',
      });

      assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.summary.totals.passed, 1);
      assert.equal(parsed.items[0].id, archiveName);
      assert.equal(existsSync(join(changeFolder, 'proposal.md')), false, 'wrapper must not leave proposal.md in archive folder');
      assert.equal(
        existsSync(join(root, 'openspec', 'changes', archiveName)),
        false,
        'wrapper must not leave the archive projection in the real changes folder'
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('wrapper fails when proposal has invalid risk_classes token in leading FM', () => {
  const { root, changeName } = buildFixture({ mode: 'full' });
  try {
    writeFileSync(
      join(root, 'openspec', 'changes', changeName, 'proposal.md'),
      FULL_PROPOSAL.replace(
        'risk_classes: [state/invariant, write]\n',
        'risk_classes: [banana]\n',
      ),
      'utf8',
    );
    const result = spawnSync('node', [SCRIPT, changeName, '--strict', '--json'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, `expected fail; stderr:\n${result.stderr}`);
    assert.match(result.stderr, /lint-risk-classes-record|invalid-token|risk_classes/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('wrapper fails when risk_classes only appears inside a fenced example (no leading FM)', () => {
  const { root, changeName } = buildFixture({ mode: 'full' });
  try {
    writeFileSync(
      join(root, 'openspec', 'changes', changeName, 'proposal.md'),
      `## Why\n\nValidate fence bypass.\n\n\`\`\`md\nrisk_classes: [auth]\n\`\`\`\n\n## Tasks\n\n見 tasks.md。\n`,
      'utf8',
    );
    const result = spawnSync('node', [SCRIPT, changeName, '--strict', '--json'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, `expected fail; stderr:\n${result.stderr}`);
    assert.match(result.stderr, /missing-risk-classes|lint-risk-classes-record/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('wrapper fails when risk_classes only appears as prose body (no leading FM)', () => {
  const { root, changeName } = buildFixture({ mode: 'full' });
  try {
    writeFileSync(
      join(root, 'openspec', 'changes', changeName, 'proposal.md'),
      `## Why\n\nValidate prose bypass.\n\nrisk_classes: [auth]\n\n## Tasks\n\n見 tasks.md。\n`,
      'utf8',
    );
    const result = spawnSync('node', [SCRIPT, changeName, '--strict', '--json'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, `expected fail; stderr:\n${result.stderr}`);
    assert.match(result.stderr, /missing-risk-classes|lint-risk-classes-record/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('wrapper fails when leading FM has none without rationale', () => {
  const { root, changeName } = buildFixture({ mode: 'full' });
  try {
    writeFileSync(
      join(root, 'openspec', 'changes', changeName, 'proposal.md'),
      `---\nrisk_classes: none\n---\n\n## Why\n\nValidate none without rationale.\n\n## Tasks\n\n見 tasks.md。\n`,
      'utf8',
    );
    const result = spawnSync('node', [SCRIPT, changeName, '--strict', '--json'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, `expected fail; stderr:\n${result.stderr}`);
    assert.match(result.stderr, /none-without-rationale|lint-risk-classes-record/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('wrapper fails when quoted risk_classes escape would forge none', () => {
  const { root, changeName } = buildFixture({ mode: 'full' });
  try {
    writeFileSync(
      join(root, 'openspec', 'changes', changeName, 'proposal.md'),
      FULL_PROPOSAL.replace(
        'risk_classes: [state/invariant, write]\n',
        'risk_classes: "no\\ne"\nrationale: would wrongly pass if backslash discarded\n',
      ),
      'utf8',
    );
    const result = spawnSync('node', [SCRIPT, changeName, '--strict', '--json'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, `expected fail; stderr:\n${result.stderr}`);
    assert.match(result.stderr, /malformed-front-matter|lint-risk-classes-record/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('wrapper fails when risk_classes flow list has empty entries', () => {
  const { root, changeName } = buildFixture({ mode: 'full' });
  try {
    writeFileSync(
      join(root, 'openspec', 'changes', changeName, 'proposal.md'),
      FULL_PROPOSAL.replace(
        'risk_classes: [state/invariant, write]\n',
        'risk_classes: [,auth]\n',
      ),
      'utf8',
    );
    const result = spawnSync('node', [SCRIPT, changeName, '--strict', '--json'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, `expected fail; stderr:\n${result.stderr}`);
    assert.match(result.stderr, /malformed-front-matter|lint-risk-classes-record/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('wrapper fails when none rationale is control-only escape', () => {
  const { root, changeName } = buildFixture({ mode: 'full' });
  try {
    writeFileSync(
      join(root, 'openspec', 'changes', changeName, 'proposal.md'),
      FULL_PROPOSAL.replace(
        'risk_classes: [state/invariant, write]\n',
        'risk_classes: none\nrationale: "\\0"\n',
      ),
      'utf8',
    );
    const result = spawnSync('node', [SCRIPT, changeName, '--strict', '--json'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, `expected fail; stderr:\n${result.stderr}`);
    assert.match(result.stderr, /none-without-rationale|lint-risk-classes-record/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('wrapper fails when none rationale is Unicode format-only', () => {
  const { root, changeName } = buildFixture({ mode: 'full' });
  try {
    writeFileSync(
      join(root, 'openspec', 'changes', changeName, 'proposal.md'),
      FULL_PROPOSAL.replace(
        'risk_classes: [state/invariant, write]\n',
        'risk_classes: none\nrationale: "\\u2060"\n',
      ),
      'utf8',
    );
    const result = spawnSync('node', [SCRIPT, changeName, '--strict', '--json'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, `expected fail; stderr:\n${result.stderr}`);
    assert.match(result.stderr, /none-without-rationale|lint-risk-classes-record/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('wrapper fails when none rationale is Hangul filler only', () => {
  const { root, changeName } = buildFixture({ mode: 'full' });
  try {
    writeFileSync(
      join(root, 'openspec', 'changes', changeName, 'proposal.md'),
      FULL_PROPOSAL.replace(
        'risk_classes: [state/invariant, write]\n',
        'risk_classes: none\nrationale: "\\u3164"\n',
      ),
      'utf8',
    );
    const result = spawnSync('node', [SCRIPT, changeName, '--strict', '--json'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, `expected fail; stderr:\n${result.stderr}`);
    assert.match(result.stderr, /none-without-rationale|lint-risk-classes-record/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('wrapper fails when none rationale is ZWJ-obfuscated TODO', () => {
  const { root, changeName } = buildFixture({ mode: 'full' });
  try {
    writeFileSync(
      join(root, 'openspec', 'changes', changeName, 'proposal.md'),
      FULL_PROPOSAL.replace(
        'risk_classes: [state/invariant, write]\n',
        'risk_classes: none\nrationale: "T\\u200DODO"\n',
      ),
      'utf8',
    );
    const result = spawnSync('node', [SCRIPT, changeName, '--strict', '--json'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, `expected fail; stderr:\n${result.stderr}`);
    assert.match(result.stderr, /none-without-rationale|lint-risk-classes-record/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('wrapper fails when none rationale is NUL-obfuscated TODO', () => {
  const { root, changeName } = buildFixture({ mode: 'full' });
  try {
    writeFileSync(
      join(root, 'openspec', 'changes', changeName, 'proposal.md'),
      FULL_PROPOSAL.replace(
        'risk_classes: [state/invariant, write]\n',
        'risk_classes: none\nrationale: "T\\0ODO"\n',
      ),
      'utf8',
    );
    const result = spawnSync('node', [SCRIPT, changeName, '--strict', '--json'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, `expected fail; stderr:\n${result.stderr}`);
    assert.match(result.stderr, /none-without-rationale|lint-risk-classes-record/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('wrapper fails when ignored FM key has unsupported escape', () => {
  const { root, changeName } = buildFixture({ mode: 'full' });
  try {
    writeFileSync(
      join(root, 'openspec', 'changes', changeName, 'proposal.md'),
      FULL_PROPOSAL.replace(
        'risk_classes: [state/invariant, write]\n',
        'title: "bad\\q"\nrisk_classes: [auth]\n',
      ),
      'utf8',
    );
    const result = spawnSync('node', [SCRIPT, changeName, '--strict', '--json'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, `expected fail; stderr:\n${result.stderr}`);
    assert.match(result.stderr, /malformed-front-matter|lint-risk-classes-record/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('wrapper skips risk_classes lint for archived path (grandfather)', () => {
  const archiveName = 'archived-prose-risk';
  const { root } = buildFixture({
    changeName: archiveName,
    changePath: `archive/${archiveName}`,
    mode: 'full',
  });
  try {
    // Prose-only record — would FAIL under active FM gate; archive must skip.
    writeFileSync(
      join(root, 'openspec', 'changes', 'archive', archiveName, 'proposal.md'),
      `## Why\n\nArchived prose risk_classes grandfather.\n\nrisk_classes: [auth]\n\n## Tasks\n\n見 tasks.md。\n`,
      'utf8',
    );
    const result = spawnSync(
      'node',
      [SCRIPT, `archive/${archiveName}`, '--strict', '--json'],
      {
        cwd: root,
        encoding: 'utf8',
      },
    );
    assert.equal(
      result.status,
      0,
      `archived path must skip risk lint; stderr:\n${result.stderr}\nstdout:\n${result.stdout}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('openspecValidateSpawnOptions enables shell:true on win32 only', () => {
  assert.deepEqual(openspecValidateSpawnOptions('/tmp', { platform: 'win32' }), {
    cwd: '/tmp',
    encoding: 'utf8',
    shell: true,
  });
  for (const platform of ['darwin', 'linux']) {
    assert.deepEqual(openspecValidateSpawnOptions('/tmp', { platform }), {
      cwd: '/tmp',
      encoding: 'utf8',
    });
  }
});

test('assertWin32OpenspecSpawnArgs rejects cmd metacharacters and non-flag argv on win32', () => {
  assert.deepEqual(assertWin32OpenspecSpawnArgs('fix-windows-openspec-spawn', ['--strict'], { platform: 'win32' }), {
    ok: true,
  });
  assert.equal(assertWin32OpenspecSpawnArgs('bad&name', ['--strict'], { platform: 'win32' }).ok, false);
  assert.equal(assertWin32OpenspecSpawnArgs('ok-name', ['--strict;calc'], { platform: 'win32' }).ok, false);
  assert.deepEqual(assertWin32OpenspecSpawnArgs('bad&name', ['--strict'], { platform: 'darwin' }), { ok: true });
});

// --- --risk-shape-probe fixtures (require a real git repo: classifyBoundedRereview
// pins carrier bytes to the committed Git object at HEAD, so these tests build
// and commit an actual repo rather than reusing buildFixture's plain temp tree). ---

const RISK_TOUCH_HEADER = '| 檔案 | 類別 | 動作 | Requirement |';

function fullRiskProposalWithHeading() {
  return [
    '---',
    'risk_classes: [state/invariant, write]',
    '---',
    '',
    '# Proposal: fixture',
    '',
    '## Capabilities',
    '',
    '### Modified Capabilities',
    '',
    '- `demo`: exact compiler fixture.',
    '',
    '## Section 1: Target State (Done When)',
    '',
    '1. Preserve the exact review authority.',
    '',
    '## Section 2: Touch',
    '',
    RISK_TOUCH_HEADER,
    '|---|---|---|---|',
    '| `src/review-target.mjs` | code | modify | R1 |',
    '',
    '不動清單：',
    '',
    '- `src/second-target.mjs`',
    '',
    '## Section 3: Tasks',
    '',
    '1. Prove the fixture.',
    '',
    '## Consequence Assessment',
    '',
    '| Dimension | Consequence |',
    '|---|---|',
    '| Security/trust/privacy/data | Fail closed before dispatch. |',
    '| Material negatives/non-goals | Do not accept caller-provided authority. |',
    '',
    '## Risk Classes and Material Negatives',
    '',
    '- `state/invariant`: dispatch authority must be reproducible.',
    '- `write`: receipt publication is durable.',
    '',
    '## Migration Notes',
    '',
    'migration note v1',
    '',
  ].join('\n');
}

function fullRiskProposalMissingHeading() {
  const complete = fullRiskProposalWithHeading();
  const marker = '## Risk Classes and Material Negatives';
  const start = complete.indexOf(marker);
  const end = complete.indexOf('## Migration Notes');
  return complete.slice(0, start) + complete.slice(end);
}

function fullRiskProposalMissingConsequenceRow() {
  const complete = fullRiskProposalWithHeading();
  const row = '| Security/trust/privacy/data | Fail closed before dispatch. |\n';
  assert.ok(complete.includes(row), 'fixture must contain the row this helper removes');
  return complete.replace(row, '');
}

const RISK_FULL_TASKS = [
  '# Tasks',
  '',
  '## Tasks',
  '',
  '- [x] [Req: R1] Validate full proposal fixture.',
  '  驗收: wrapper exercised for full proposal.md',
  '',
].join('\n');

const RISK_FULL_DESIGN = [
  '# Design: fixture',
  '',
  '## Decisions',
  '',
  '### D1 — Exact authority',
  '',
  'Derive authority from exact selected sections.',
  '',
  '### D2 — Durable binding',
  '',
  'Bind the logical dispatch to current Git state.',
  '',
  '## Test Log',
  '',
  'test log v1',
  '',
].join('\n');

function git(repoRoot, args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
}

// B-mini fixture for the probe: no design.md, no ## Risk Classes/Consequence
// Assessment (those headings are full-change-only), same specs/demo delta as
// the full fixture so the probe's specs/<capability>/spec.md pinning is
// exercised identically for both shapes.
const RISK_MINI_PROPOSAL = `---
risk_classes: none
rationale: --risk-shape-probe B-mini fixture (no auth/state/write/disclosure surface)
---

## Why

Exercise the probe's B-mini path (proposal-mini.md shim in tempRoot, probe against real repoRoot).

## What Changes

- Add a proposal-mini validation shim.

## Target State

- [Req: R1] B-mini fixture validates and the probe passes once every pinned carrier is committed.

## Touch

${RISK_TOUCH_HEADER}
|---|---|---|---|
| \`src/review-target.mjs\` | code | modify | R1 |

## Tasks

- [x] [Req: R1] Validate B-mini risk-shape-probe fixture.
  驗收: wrapper exercised for proposal-mini.md
`;

function buildGitRiskFixture({
  changeName = 'full-risk-change',
  proposal = fullRiskProposalWithHeading(),
  design = RISK_FULL_DESIGN,
  mode = 'full',
} = {}) {
  const root = join(tmpdir(), `validate-openspec-change-risk-probe-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const changeFolder = join(root, 'openspec', 'changes', changeName);
  mkdirSync(join(changeFolder, 'specs', 'demo'), { recursive: true });
  mkdirSync(join(root, 'openspec', 'specs', 'demo'), { recursive: true });
  mkdirSync(join(root, '.devpro'), { recursive: true });

  if (mode === 'mini') {
    writeFileSync(join(changeFolder, 'proposal-mini.md'), RISK_MINI_PROPOSAL, 'utf8');
  } else {
    writeFileSync(join(changeFolder, 'proposal.md'), proposal, 'utf8');
    writeFileSync(join(changeFolder, 'tasks.md'), RISK_FULL_TASKS, 'utf8');
    writeFileSync(join(changeFolder, 'design.md'), design, 'utf8');
  }
  writeFileSync(join(changeFolder, 'specs', 'demo', 'spec.md'), DELTA_PRESERVES_SCENARIOS, 'utf8');
  writeFileSync(join(root, 'openspec', 'specs', 'demo', 'spec.md'), CANONICAL, 'utf8');

  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'test']);

  return { root, changeFolder, changeName };
}

function commitAllRisk(root, message) {
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', message]);
  // Receipt tip SSOT is exact-ref refs/remotes/origin/main (classify-bounded /
  // risk-shape-probe). Temp fixtures must pin it or authority is unavailable.
  const tip = git(root, ['rev-parse', 'HEAD']).trim();
  git(root, ['update-ref', 'refs/remotes/origin/main', tip]);
}

test('--risk-shape-probe: committed full proposal missing Risk Classes heading fails with a proposal-template.md pointer', () => {
  const { root, changeName } = buildGitRiskFixture({ proposal: fullRiskProposalMissingHeading() });
  try {
    commitAllRisk(root, 'initial fixture');
    const result = spawnSync('node', [SCRIPT, changeName, '--strict', '--risk-shape-probe'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stderr, /risk_shape_unavailable/);
    assert.match(result.stderr, /risk_shape_debug_reason: [a-z0-9_]+\./, 'probe must surface the closed-enum debug reason');
    assert.match(result.stderr, /proposal-template\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--risk-shape-probe: committed full proposal with all required carriers passes', () => {
  const { root, changeName } = buildGitRiskFixture();
  try {
    commitAllRisk(root, 'initial fixture');
    const result = spawnSync('node', [SCRIPT, changeName, '--strict', '--risk-shape-probe'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--risk-shape-probe: uncommitted proposal fails with a distinct not-committed message, never risk_shape_unavailable', () => {
  const { root, changeName, changeFolder } = buildGitRiskFixture();
  try {
    commitAllRisk(root, 'initial fixture');
    writeFileSync(join(changeFolder, 'proposal.md'), `${fullRiskProposalWithHeading()}\nuncommitted edit\n`, 'utf8');
    const result = spawnSync('node', [SCRIPT, changeName, '--strict', '--risk-shape-probe'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stderr, /not yet committed/);
    assert.doesNotMatch(result.stderr, /risk_shape_unavailable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--risk-shape-probe: clean git status (assume-unchanged) still fails the byte-pin when worktree bytes diverge from the HEAD blob', () => {
  // Regression for the same root cause a Windows core.autocrlf=true checkout triggers: after
  // checkout, git's stat cache can report a carrier clean even though its raw worktree bytes
  // (e.g. LF blob checked out as CRLF) differ from the exact bytes classify-bounded pins at
  // HEAD. `git update-index --assume-unchanged` reproduces the same "clean status, divergent
  // bytes" condition deterministically and cross-platform, without depending on a real
  // checkout's stat-cache race. The probe must not trust `git status` for this judgment.
  const { root, changeName, changeFolder } = buildGitRiskFixture();
  try {
    commitAllRisk(root, 'initial fixture');
    const gitPath = `openspec/changes/${changeName}/proposal.md`;
    git(root, ['update-index', '--assume-unchanged', gitPath]);
    const proposalPath = join(changeFolder, 'proposal.md');
    const committedText = readFileSync(proposalPath, 'utf8');
    writeFileSync(proposalPath, committedText.replace(/\n/g, '\r\n'), 'utf8');
    const status = spawnSync('git', ['status', '--porcelain', '--', gitPath], { cwd: root, encoding: 'utf8' });
    assert.equal(status.stdout.trim(), '', `expected assume-unchanged to keep status clean, got:\n${status.stdout}`);
    const result = spawnSync('node', [SCRIPT, changeName, '--strict', '--risk-shape-probe'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stderr, /not yet committed/);
    assert.doesNotMatch(result.stderr, /risk_shape_unavailable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--risk-shape-probe: committed full proposal missing a Consequence Assessment row fails with a proposal-template.md pointer', () => {
  const { root, changeName } = buildGitRiskFixture({ proposal: fullRiskProposalMissingConsequenceRow() });
  try {
    commitAllRisk(root, 'initial fixture');
    const result = spawnSync('node', [SCRIPT, changeName, '--strict', '--risk-shape-probe'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stderr, /risk_shape_unavailable/);
    assert.match(result.stderr, /proposal-template\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--risk-shape-probe: full change with no design.md at all fails with a distinct missing-file message', () => {
  const { root, changeName, changeFolder } = buildGitRiskFixture();
  rmSync(join(changeFolder, 'design.md'));
  try {
    commitAllRisk(root, 'initial fixture without design.md');
    const result = spawnSync('node', [SCRIPT, changeName, '--strict', '--risk-shape-probe'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stderr, /design\.md is missing/);
    assert.match(result.stderr, /design-template\.md/);
    assert.doesNotMatch(result.stderr, /risk_shape_unavailable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--risk-shape-probe: archived target prints a skip notice and exits 0', () => {
  const archiveName = 'archived-risk-shape-probe-target';
  const { root, changeName } = buildFixture({
    changeName: archiveName,
    changePath: `archive/${archiveName}`,
    mode: 'mini',
  });
  try {
    const result = spawnSync('node', [SCRIPT, `archive/${changeName}`, '--strict', '--risk-shape-probe'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stderr, /skipped for archived target/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--risk-shape-probe: committed B-mini proposal with all required carriers passes', () => {
  const { root, changeName } = buildGitRiskFixture({ changeName: 'mini-risk-change', mode: 'mini' });
  try {
    commitAllRisk(root, 'initial B-mini fixture');
    const result = spawnSync('node', [SCRIPT, changeName, '--strict', '--risk-shape-probe'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--risk-shape-probe: B-mini with an uncommitted specs delta fails with a distinct not-committed message', () => {
  const { root, changeName, changeFolder } = buildGitRiskFixture({ changeName: 'mini-risk-change-dirty-delta', mode: 'mini' });
  try {
    commitAllRisk(root, 'initial B-mini fixture');
    writeFileSync(
      join(changeFolder, 'specs', 'demo', 'spec.md'),
      `${DELTA_PRESERVES_SCENARIOS}\nuncommitted edit\n`,
      'utf8',
    );
    const result = spawnSync('node', [SCRIPT, changeName, '--strict', '--risk-shape-probe'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stderr, /not yet committed/);
    assert.doesNotMatch(result.stderr, /risk_shape_unavailable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--strict alone runs the risk-shape probe without --risk-shape-probe', () => {
  // Prove-it for fix-false-green-signals D2: --strict must imply the probe so
  // heading/shape defects cannot stay latent until classify-bounded.
  const { root, changeName } = buildGitRiskFixture({ proposal: fullRiskProposalMissingHeading() });
  try {
    commitAllRisk(root, 'initial fixture missing Risk Classes');
    const result = spawnSync('node', [SCRIPT, changeName, '--strict'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stderr, /risk_shape_unavailable|proposal-template\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('bare validate without --strict or --risk-shape-probe stays probe-off', () => {
  const { root, changeName } = buildGitRiskFixture({ proposal: fullRiskProposalMissingHeading() });
  try {
    commitAllRisk(root, 'initial fixture missing Risk Classes');
    const result = spawnSync('node', [SCRIPT, changeName], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.doesNotMatch(result.stderr, /risk-shape-probe/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--strict alone still skips the probe for archived targets', () => {
  const archiveName = 'archived-strict-implies-probe-skip';
  const { root, changeName } = buildFixture({
    changeName: archiveName,
    changePath: `archive/${archiveName}`,
    mode: 'mini',
  });
  try {
    const result = spawnSync('node', [SCRIPT, `archive/${changeName}`, '--strict'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stderr, /skipped for archived target/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--strict: near-miss design decision headings fail with 標題格式不對 (not bare risk_shape_unavailable alone)', () => {
  const badDesign = [
    '# Design: fixture',
    '',
    '## Decisions',
    '',
    '### D1',
    '',
    'Bare number without em-dash title.',
    '',
    '### D2：全形冒號標題',
    '',
    'Colon variant must also be rejected.',
    '',
  ].join('\n');
  const { root, changeName, changeFolder } = buildGitRiskFixture({ design: badDesign });
  try {
    commitAllRisk(root, 'fixture with near-miss decision headings');
    const result = spawnSync('node', [SCRIPT, changeName, '--strict'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stderr, /標題格式不對/);
    assert.doesNotMatch(
      result.stderr,
      /^\[validate-openspec-change\] risk-shape-probe: risk-shape derivation failed \(route: risk_shape_unavailable\)\.\s*$/m,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--strict: legal ### D<n> — title decision headings still pass risk-shape probe', () => {
  const { root, changeName } = buildGitRiskFixture();
  try {
    commitAllRisk(root, 'fixture with legal em-dash decision headings');
    const result = spawnSync('node', [SCRIPT, changeName, '--strict'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.doesNotMatch(result.stderr, /標題格式不對/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- exact bare-title match + REMOVED Requirement scenarios (strengthen-pre-archive-promotion-lint) ---

test('stripRemovedScenariosFromTempCanonicalSpecs does not honor a `Scenario: ` prefixed declaration (exact bare-title match)', () => {
  const tempRoot = join(tmpdir(), `strip-prefixed-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const specsDir = join(tempRoot, 'openspec', 'specs', 'demo');
  mkdirSync(specsDir, { recursive: true });
  const specPath = join(specsDir, 'spec.md');
  try {
    writeFileSync(specPath, CANONICAL);
    const prefixed = stripRemovedScenariosFromTempCanonicalSpecs(tempRoot, new Set(['Scenario: Invalid Input']));
    assert.equal(prefixed.ok, true, prefixed.error);
    assert.match(readFileSync(specPath, 'utf8'), /Scenario: Invalid Input/, 'prefixed declaration must not strip');

    const bare = stripRemovedScenariosFromTempCanonicalSpecs(tempRoot, new Set(['Invalid Input']));
    assert.equal(bare.ok, true, bare.error);
    assert.doesNotMatch(readFileSync(specPath, 'utf8'), /Scenario: Invalid Input/, 'bare declaration still strips');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

const DELTA_REMOVED_ONLY_UNDECLARED = `# demo Spec Delta

## REMOVED Requirements

### Requirement: Widget Processing

**Reason**: superseded.

#### Scenario: Happy Path
- **WHEN** a valid widget is submitted
- **THEN** the system SHALL accept it

#### Scenario: Invalid Input
- **WHEN** an invalid widget is submitted
- **THEN** the system SHALL reject it
`;

test('REMOVED-only delta with an undeclared scenario fails the wrapper with the REMOVED line and bare-title hint', () => {
  const { root, changeName } = buildFixture({
    changeName: 'removed-only-undeclared',
    delta: DELTA_REMOVED_ONLY_UNDECLARED,
  });
  try {
    const result = spawnSync('node', [SCRIPT, changeName, '--strict'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(
      result.stderr,
      /\[validate-openspec-change\] demo :: Requirement "Widget Processing" :: removed scenario "Happy Path" not declared/,
    );
    assert.match(result.stderr, /:: removed scenario "Invalid Input" not declared/);
    assert.match(result.stderr, /bare title/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('wrapper prints delta-local `## Removed Scenarios` locationErrors instead of exiting 1 silently', () => {
  const { root, changeName } = buildFixture({
    changeName: 'delta-local-removed-heading',
    delta: `${DELTA_DROPS_SCENARIO}\n## Removed Scenarios\n- "Invalid Input"\n`,
  });
  try {
    const result = spawnSync('node', [SCRIPT, changeName, '--strict'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stderr, /delta-local "## Removed Scenarios"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test('strict validation reports multi-pair warning while preserving a successful verdict', () => {
  const delta = '## ADDED Requirements\n\n### Requirement: Multi Pair Retry\n\nThe system SHALL check each retry outcome.\n\n#### Scenario: Multi Pair Retry Outcomes\n\n- **WHEN** first attempt completes\n- **THEN** release the record\n- **WHEN** retry leaves residue\n- **THEN** reject the retry\n';
  const { root, changeName } = buildFixture({ delta });
  try {
    const result = spawnSync(process.execPath, [SCRIPT, changeName, '--strict', '--json'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).summary.totals.passed, 1);
    assert.match(result.stderr, /warning:.*Multi Pair Retry Outcomes.*WHEN\/THEN groups 1,2/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
