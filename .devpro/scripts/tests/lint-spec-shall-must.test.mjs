import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  lintSpec,
  parseRequirements,
  lintPath,
  formatPassMessage,
} from '../lint-spec-shall-must.mjs';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '../lint-spec-shall-must.mjs');

const FIXTURE_A_SINGLE_SUB_MISSING = `# foo Delta Specification

## Purpose

A test fixture for lint.

## ADDED Requirements

### Requirement: Single Sub Missing SHALL

This requirement main section is fine and contains SHALL.

#### Scenario: Sub Without Shall
- WHEN something happens
- THEN nothing required here
`;

const FIXTURE_B_MULTI_SUB_SECOND_MISSING = `# foo Delta Specification

## Purpose

Another test fixture.

## MODIFIED Requirements

### Requirement: Multi Sub Second Missing

Main section SHALL apply.

#### Scenario: First Sub Has Shall
- WHEN x SHALL y

#### Scenario: Second Sub Missing Must
- WHEN p
- THEN q (no required keyword here either)

#### Scenario: Third Sub Has Must
- WHEN m MUST n
`;

describe('parseRequirements structural separator boundaries', () => {
  test('exact standalone separator terminates an LF requirement before the next requirement', () => {
    const requirements = parseRequirements(`# Separator boundary

## Requirements

### Requirement: First requirement
The first requirement SHALL remain unchanged.

#### Scenario: First scenario
- **THEN** the first outcome remains unchanged

---

### Requirement: Final requirement
The final requirement SHALL remain unchanged.

#### Scenario: Final scenario
- **THEN** the final outcome remains unchanged
`);

    assert.equal(requirements.length, 2);
    assert.equal(requirements[0].name, 'First requirement');
    assert.equal(
      requirements[0].subSections[0].text,
      '- **THEN** the first outcome remains unchanged\n'
    );
    assert.equal(requirements[1].name, 'Final requirement');
    assert.equal(
      requirements[1].subSections[0].text,
      '- **THEN** the final outcome remains unchanged\n'
    );
  });

  test('exact LF separator terminates a requirement main body without subsections', () => {
    const requirements = parseRequirements(`## Requirements

### Requirement: Main body only
The main-only requirement SHALL stop before structural blank lines.


---

### Requirement: Final EOF requirement
The final requirement SHALL remain parsed through EOF.
`);

    assert.equal(requirements.length, 2);
    assert.equal(requirements[0].name, 'Main body only');
    assert.equal(
      requirements[0].mainSection,
      'The main-only requirement SHALL stop before structural blank lines.\n'
    );
    assert.equal(requirements[0].subSections.length, 0);
    assert.equal(requirements[1].name, 'Final EOF requirement');
    assert.equal(
      requirements[1].mainSection,
      'The final requirement SHALL remain parsed through EOF.\n'
    );
    assert.equal(requirements[1].subSections.length, 0);
  });

  test('exact standalone separator terminates a CRLF requirement before the next requirement', () => {
    const content = `# Separator boundary

## Requirements

### Requirement: First requirement
The first requirement SHALL remain unchanged.

#### Scenario: First scenario
- **THEN** the first outcome remains unchanged

---

### Requirement: Final requirement
The final requirement SHALL remain unchanged.

#### Scenario: Final scenario
- **THEN** the final outcome remains unchanged
`.replaceAll('\n', '\r\n');
    const requirements = parseRequirements(content);

    assert.equal(requirements.length, 2);
    assert.equal(requirements[0].name, 'First requirement');
    assert.equal(
      requirements[0].subSections[0].text,
      '- **THEN** the first outcome remains unchanged\r\n'
    );
    assert.equal(requirements[1].name, 'Final requirement');
    assert.equal(
      requirements[1].subSections[0].text,
      '- **THEN** the final outcome remains unchanged\r\n'
    );
  });

  test('single requirement keeps its final scenario through EOF', () => {
    const requirements = parseRequirements(`## Requirements

### Requirement: Only requirement
The only requirement SHALL remain unchanged.

#### Scenario: Only scenario
- **THEN** the only outcome remains unchanged
`);

    assert.equal(requirements.length, 1);
    assert.equal(requirements[0].name, 'Only requirement');
    assert.equal(
      requirements[0].subSections[0].text,
      '- **THEN** the only outcome remains unchanged\n'
    );
  });

  test('non-exact separator-like lines remain ordinary requirement content', () => {
    const requirements = parseRequirements(`## Requirements

### Requirement: First requirement
The first requirement SHALL remain unchanged.

#### Scenario: First scenario
- **THEN** separator-like lines remain ordinary content
----
***
___
 ---
${'--- '}
### Requirement: Final requirement
The final requirement SHALL remain unchanged.

#### Scenario: Final scenario
- **THEN** the final outcome remains unchanged
`);

    assert.equal(requirements.length, 2);
    assert.equal(
      requirements[0].subSections[0].text,
      '- **THEN** separator-like lines remain ordinary content\n----\n***\n___\n ---\n--- \n'
    );
    assert.equal(requirements[1].name, 'Final requirement');
  });
});

describe('lint-spec-shall-must', () => {
  test('Fixture A: single sub-requirement missing SHALL → fail with段標示', () => {
    const result = lintSpec({ content: FIXTURE_A_SINGLE_SUB_MISSING, file: 'fixture-a.md' });
    assert.equal(result.pass, false);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /Requirement "Single Sub Missing SHALL"/);
    assert.match(result.errors[0], /sub-section #1/);
    assert.match(result.errors[0], /Sub Without Shall/);
  });

  test('Fixture B: multi sub block, 2nd sub missing MUST → fail 含 #2', () => {
    const result = lintSpec({ content: FIXTURE_B_MULTI_SUB_SECOND_MISSING, file: 'fixture-b.md' });
    assert.equal(result.pass, false);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /Requirement "Multi Sub Second Missing"/);
    assert.match(result.errors[0], /sub-section #2/);
    assert.match(result.errors[0], /Second Sub Missing Must/);
  });

  test('all good fixture: pass', () => {
    const good = `# x

## Purpose

ok.

## ADDED Requirements

### Requirement: All Good

Main SHALL apply.

#### Scenario: Has Must
- WHEN x MUST y
`;
    const result = lintSpec({ content: good, file: 'good.md' });
    assert.equal(result.pass, true);
    assert.equal(result.errors.length, 0);
  });

  test('Fixture C: main section missing SHALL → fail with main section 標示', () => {
    const fixture = `# foo Delta Specification

## Purpose

Test main section missing.

## ADDED Requirements

### Requirement: Main Section Missing

Main section here without keyword.

#### Scenario: Sub Has Shall
- WHEN x SHALL y
`;
    const result = lintSpec({ content: fixture, file: 'fixture-c.md' });
    assert.equal(result.pass, false);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /Requirement "Main Section Missing"/);
    assert.match(result.errors[0], /main section missing SHALL\/MUST/);
  });

  test('Fixture D: ADDED + MODIFIED 雙 block 各有缺陷 → 報兩個 error', () => {
    const fixture = `# foo Delta Specification

## Purpose

Test dual blocks.

## ADDED Requirements

### Requirement: Added One Sub Missing

Main SHALL apply.

#### Scenario: Missing Keyword Here
- WHEN nothing required

## MODIFIED Requirements

### Requirement: Modified Main Missing

Main no keyword.

#### Scenario: Sub Has Must
- WHEN x MUST y
`;
    const result = lintSpec({ content: fixture, file: 'fixture-d.md' });
    assert.equal(result.pass, false);
    assert.equal(result.errors.length, 2);
    const errorText = result.errors.join('\n');
    assert.match(errorText, /Requirement "Added One Sub Missing".*sub-section #1/);
    assert.match(errorText, /Requirement "Modified Main Missing".*main section/);
  });

  test('lintPath: walks /specs/ tree, SKIP_DIRS excludes node_modules', () => {
    const root = join(tmpdir(), `lint-walk-${Date.now()}`);
    mkdirSync(join(root, 'specs', 'foo'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'pkg', 'specs'), { recursive: true });
    writeFileSync(
      join(root, 'specs', 'foo', 'spec.md'),
      `# foo

## Purpose

real spec.

## ADDED Requirements

### Requirement: Real

Main SHALL.

#### Scenario: Has shall
- WHEN x SHALL y
`,
    );
    writeFileSync(
      join(root, 'node_modules', 'pkg', 'specs', 'spec.md'),
      `# pkg

## ADDED Requirements

### Requirement: Should Be Skipped
Main no keyword.
#### Scenario: also no keyword
- nothing
`,
    );
    try {
      const result = lintPath(root);
      assert.equal(result.pass, true, `unexpected errors: ${result.errors.join(', ')}`);
      assert.equal(result.fileCount, 1);
      assert.equal(result.requirementCount, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('formatPassMessage: success MUST carry range+count; bare ": pass" is forbidden', () => {
    const withCount = formatPassMessage('openspec/specs', {
      requirementCount: 3,
      fileCount: 2,
    });
    assert.match(withCount, /3 requirement\(s\) scanned/);
    assert.doesNotMatch(withCount, /: pass$/);

    const zeroFiles = formatPassMessage('empty-dir', {
      requirementCount: 0,
      fileCount: 0,
    });
    assert.match(zeroFiles, /no applicable files in empty-dir/);
    assert.doesNotMatch(zeroFiles, /: pass$/);
  });

  test('CLI success stdout locks range+count (not bare ": pass")', () => {
    const root = join(tmpdir(), `lint-cli-${Date.now()}`);
    const specPath = join(root, 'specs', 'foo', 'spec.md');
    mkdirSync(join(root, 'specs', 'foo'), { recursive: true });
    writeFileSync(
      specPath,
      `# foo

## Purpose

ok.

## ADDED Requirements

### Requirement: Real

Main SHALL.

#### Scenario: Has shall
- WHEN x SHALL y
`,
    );
    try {
      const r = spawnSync('node', [SCRIPT, root], { encoding: 'utf8' });
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.match(r.stdout, /1 requirement\(s\) scanned/);
      assert.doesNotMatch(r.stdout.trim(), /: pass$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('CLI 0-object form when directory has no /specs/ files', () => {
    const root = join(tmpdir(), `lint-cli-empty-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    try {
      const r = spawnSync('node', [SCRIPT, root], { encoding: 'utf8' });
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.ok(
        r.stdout.includes(`no applicable files in ${root}`),
        `stdout missing 0-object form: ${r.stdout}`
      );
      assert.doesNotMatch(r.stdout.trim(), /: pass$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// Issue #3235: a Windows checkout with core.autocrlf=true has CRLF spec files.
describe('lint-spec-shall-must line endings and empty blocks', () => {
  test('a CRLF spec reports the same requirements and errors as its LF form', () => {
    const lf = lintSpec({ content: FIXTURE_A_SINGLE_SUB_MISSING, file: 'spec.md' });
    const crlf = lintSpec({ content: FIXTURE_A_SINGLE_SUB_MISSING.replaceAll('\n', '\r\n'), file: 'spec.md' });
    assert.equal(lf.requirementCount, 1);
    assert.equal(crlf.requirementCount, lf.requirementCount);
    assert.equal(crlf.pass, false);
    assert.deepEqual(crlf.errors, lf.errors);
  });

  test('an ADDED/MODIFIED heading whose block yields no requirement fails instead of passing with zero scanned', () => {
    for (const eol of ['\n', '\r\n']) {
      const content = ['# foo Delta Specification', '', '## ADDED Requirements', '', '### Requirement Missing Colon', '', 'Text with SHALL.', ''].join(eol);
      const result = lintSpec({ content, file: 'spec.md' });
      assert.equal(result.pass, false, JSON.stringify(eol));
      assert.equal(result.requirementCount, 0);
      assert.match(result.errors.join('\n'), /\[spec\.md\] "## ADDED Requirements" has no "### Requirement:" entry/);
    }
  });

  test('a spec without any ADDED/MODIFIED heading still passes with zero scanned', () => {
    const result = lintSpec({ content: '# foo\n\n## Purpose\n\nText.\n\n## REMOVED Requirements\n\n### Requirement: Gone\n', file: 'spec.md' });
    assert.equal(result.pass, true);
    assert.equal(result.requirementCount, 0);
  });
});
