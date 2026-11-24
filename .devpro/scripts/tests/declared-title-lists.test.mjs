/**
 * declared-title-lists.test.mjs
 *
 * Unit tests for .devpro/scripts/lib/declared-title-lists.mjs — the generic
 * "H2 heading followed by a bullet list of titles" escape-hatch parser shared by
 * `## Removed Scenarios` and `## Dependency-Absorbed Requirements`.
 *
 * Covers:
 *   - parseDeclaredTitlesFromBody: heading is parameterized and matched exactly,
 *     bullet variants, section boundary, regex-metacharacter safety
 *   - collectDeclaredTitles: multi-file union, missing files, custom candidates
 *   - the delegation contract: removed-scenarios.mjs keeps its own heading and
 *     never picks up the other hatch's bullets
 */

import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseDeclaredTitlesFromBody,
  collectDeclaredTitles,
  DEFAULT_DECLARATION_FILES,
} from '../lib/declared-title-lists.mjs';
import {
  parseRemovedScenariosFromBody,
  collectRemovedScenarios,
} from '../lib/removed-scenarios.mjs';

const ABSORBED = 'Dependency-Absorbed Requirements';
const REMOVED = 'Removed Scenarios';

function tmpDir() {
  const dir = join(tmpdir(), `dtl-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('parseDeclaredTitlesFromBody', () => {
  test('returns empty Set when the requested heading is absent', () => {
    const body = '# Title\n\n## Some Heading\n\n- Foo\n';
    assert.equal(parseDeclaredTitlesFromBody(body, ABSORBED).size, 0);
  });

  test('parses bullet variants: bare, double-quoted, single-quoted, backtick, asterisk', () => {
    const body = `## ${ABSORBED}
- Bare Title
- "Double Quoted"
- 'Single Quoted'
- \`Backticked\`
* Asterisk Bullet
`;
    const result = parseDeclaredTitlesFromBody(body, ABSORBED);
    assert.deepEqual(
      [...result].sort(),
      ['Asterisk Bullet', 'Backticked', 'Bare Title', 'Double Quoted', 'Single Quoted'],
    );
  });

  test('stops collecting at the next ## heading', () => {
    const body = `## ${ABSORBED}
- "Kept"

## Next Section
- "Not Mine"
`;
    const result = parseDeclaredTitlesFromBody(body, ABSORBED);
    assert.deepEqual([...result], ['Kept']);
  });

  test('the heading must match exactly, not as a prefix', () => {
    const body = `## ${ABSORBED} Extra\n- "Should Not Match"\n`;
    assert.equal(parseDeclaredTitlesFromBody(body, ABSORBED).size, 0);
  });

  test('two hatches in the same body do not read each other\'s bullets', () => {
    const body = `## ${REMOVED}
- "A Removed Scenario"

## ${ABSORBED}
- "An Absorbed Requirement"
`;
    assert.deepEqual([...parseDeclaredTitlesFromBody(body, REMOVED)], ['A Removed Scenario']);
    assert.deepEqual([...parseDeclaredTitlesFromBody(body, ABSORBED)], ['An Absorbed Requirement']);
  });

  test('regex metacharacters in the heading are matched literally, not as a pattern', () => {
    // A heading is caller-supplied; interpolating it raw would make `.` and `+`
    // match arbitrary text and silently widen the hatch.
    const body = '## A.B+C\n- "Literal Heading"\n';
    assert.deepEqual([...parseDeclaredTitlesFromBody(body, 'A.B+C')], ['Literal Heading']);
    assert.equal(parseDeclaredTitlesFromBody('## AXBC\n- "Wrong"\n', 'A.B+C').size, 0);
  });

  test('trims whitespace and ignores non-bullet lines', () => {
    const body = `## ${ABSORBED}
This is prose, not a declaration.
-   "  Padded Title  "
`;
    assert.deepEqual([...parseDeclaredTitlesFromBody(body, ABSORBED)], ['Padded Title']);
  });
});

describe('collectDeclaredTitles', () => {
  test('unions across the default candidate files and dedupes', () => {
    const dir = tmpDir();
    try {
      writeFileSync(join(dir, 'proposal.md'), `## ${ABSORBED}\n- "Alpha"\n`, 'utf8');
      writeFileSync(join(dir, 'tasks.md'), `## ${ABSORBED}\n- "Beta"\n- "Alpha"\n`, 'utf8');
      writeFileSync(join(dir, 'decisions.md'), `## ${ABSORBED}\n- "Gamma"\n`, 'utf8');
      const result = collectDeclaredTitles(dir, ABSORBED);
      assert.deepEqual([...result].sort(), ['Alpha', 'Beta', 'Gamma']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('skips missing candidate files without error', () => {
    const dir = tmpDir();
    try {
      writeFileSync(join(dir, 'proposal-mini.md'), `## ${ABSORBED}\n- "Only One"\n`, 'utf8');
      assert.deepEqual([...collectDeclaredTitles(dir, ABSORBED)], ['Only One']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('accepts a custom candidates list', () => {
    const dir = tmpDir();
    try {
      writeFileSync(join(dir, 'custom.md'), `## ${ABSORBED}\n- "Custom File"\n`, 'utf8');
      assert.equal(collectDeclaredTitles(dir, ABSORBED).size, 0);
      assert.deepEqual([...collectDeclaredTitles(dir, ABSORBED, ['custom.md'])], ['Custom File']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('DEFAULT_DECLARATION_FILES is the candidate set both hatches share', () => {
    assert.deepEqual(DEFAULT_DECLARATION_FILES, ['proposal.md', 'proposal-mini.md', 'tasks.md', 'decisions.md']);
  });
});

describe('removed-scenarios delegation contract', () => {
  test('parseRemovedScenariosFromBody is the Removed Scenarios projection of the generic parser', () => {
    const body = `## ${REMOVED}
- "Kept Scenario"

## ${ABSORBED}
- "Not A Scenario"
`;
    assert.deepEqual(
      [...parseRemovedScenariosFromBody(body)].sort(),
      [...parseDeclaredTitlesFromBody(body, REMOVED)].sort(),
    );
    assert.ok(!parseRemovedScenariosFromBody(body).has('Not A Scenario'));
  });

  test('collectRemovedScenarios keeps its own default candidate list and heading', () => {
    const dir = tmpDir();
    try {
      writeFileSync(join(dir, 'decisions.md'), `## ${REMOVED}\n- "Scenario X"\n## ${ABSORBED}\n- "Requirement Y"\n`, 'utf8');
      assert.deepEqual([...collectRemovedScenarios(dir)], ['Scenario X']);
      assert.deepEqual([...collectDeclaredTitles(dir, ABSORBED)], ['Requirement Y']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
