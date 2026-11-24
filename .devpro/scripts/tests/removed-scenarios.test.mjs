/**
 * removed-scenarios.test.mjs
 *
 * Unit tests for .devpro/scripts/lib/removed-scenarios.mjs
 *
 * Covers:
 *   - parseRemovedScenariosFromBody: heading absent, bare title, quoted variants,
 *     backtick variant, stops at next ## heading, trims whitespace
 *   - collectRemovedScenarios: multi-file union, missing files graceful skip,
 *     custom candidates list
 */

import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseRemovedScenariosFromBody,
  collectRemovedScenarios,
} from '../lib/removed-scenarios.mjs';

// ─── parseRemovedScenariosFromBody ──────────────────────────────────────────

describe('parseRemovedScenariosFromBody', () => {
  test('returns empty Set when ## Removed Scenarios heading is absent', () => {
    const body = '# Title\n\n## Some Heading\n\n- Foo\n';
    const result = parseRemovedScenariosFromBody(body);
    assert.equal(result.size, 0);
  });

  test('returns empty Set for empty body', () => {
    assert.equal(parseRemovedScenariosFromBody('').size, 0);
  });

  test('parses bare title (no quotes)', () => {
    const body = '## Removed Scenarios\n- Happy Path\n';
    const result = parseRemovedScenariosFromBody(body);
    assert.ok(result.has('Happy Path'), 'should contain bare title');
    assert.equal(result.size, 1);
  });

  test('parses double-quoted title', () => {
    const body = '## Removed Scenarios\n- "Invalid Input"\n';
    const result = parseRemovedScenariosFromBody(body);
    assert.ok(result.has('Invalid Input'), 'should contain title without quotes');
    assert.equal(result.size, 1);
  });

  test('parses single-quoted title', () => {
    const body = "## Removed Scenarios\n- 'Edge Case Scenario'\n";
    const result = parseRemovedScenariosFromBody(body);
    assert.ok(result.has('Edge Case Scenario'));
    assert.equal(result.size, 1);
  });

  test('parses backtick-quoted title', () => {
    const body = '## Removed Scenarios\n- `Invalid Input`\n';
    const result = parseRemovedScenariosFromBody(body);
    assert.ok(result.has('Invalid Input'));
    assert.equal(result.size, 1);
  });

  test('parses asterisk bullet (- vs *)', () => {
    const body = '## Removed Scenarios\n* "Asterisk Case"\n';
    const result = parseRemovedScenariosFromBody(body);
    assert.ok(result.has('Asterisk Case'));
    assert.equal(result.size, 1);
  });

  test('stops collecting at the next ## heading', () => {
    const body = `## Removed Scenarios
- "Foo"
- "Bar"

## Next Section
- "Should Not Be Included"
`;
    const result = parseRemovedScenariosFromBody(body);
    assert.ok(result.has('Foo'));
    assert.ok(result.has('Bar'));
    assert.ok(!result.has('Should Not Be Included'), 'must not collect past next ## heading');
    assert.equal(result.size, 2);
  });

  test('collects multiple titles from single section', () => {
    const body = `## Removed Scenarios
- "Scenario Alpha"
- Scenario Beta
- \`Scenario Gamma\`
`;
    const result = parseRemovedScenariosFromBody(body);
    assert.ok(result.has('Scenario Alpha'));
    assert.ok(result.has('Scenario Beta'));
    assert.ok(result.has('Scenario Gamma'));
    assert.equal(result.size, 3);
  });

  test('trims whitespace from parsed titles', () => {
    const body = '## Removed Scenarios\n-   "  Padded Title  "  \n';
    const result = parseRemovedScenariosFromBody(body);
    // Regex strips outer quotes then trims; inner spaces of the title are preserved
    // The regex is: /^\s*[-*]\s+["'`]?(.+?)["'`]?\s*$/ with trim() on the capture
    // "  Padded Title  " → capture group = "  Padded Title  " → after trim() = "Padded Title"
    assert.ok(result.has('Padded Title'), `got: ${JSON.stringify([...result])}`);
  });

  test('## Removed Scenarios heading must be exact (non-matching partial)', () => {
    const body = '## Removed Scenarios Extra\n- "Should Not Match"\n';
    const result = parseRemovedScenariosFromBody(body);
    assert.equal(result.size, 0, 'partial heading should not match');
  });

  test('ignores lines that do not match bullet pattern', () => {
    const body = `## Removed Scenarios
This is a prose line.
- "Valid Title"
  just text
`;
    const result = parseRemovedScenariosFromBody(body);
    assert.ok(result.has('Valid Title'));
    assert.equal(result.size, 1);
  });
});

// ─── collectRemovedScenarios ─────────────────────────────────────────────────

describe('collectRemovedScenarios', () => {
  test('returns empty Set when directory has no candidate files', () => {
    const dir = join(tmpdir(), `rsc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    try {
      const result = collectRemovedScenarios(dir);
      assert.equal(result.size, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('reads from proposal-mini.md by default', () => {
    const dir = join(tmpdir(), `rsc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'proposal-mini.md'), '## Removed Scenarios\n- "From Proposal Mini"\n', 'utf8');
    try {
      const result = collectRemovedScenarios(dir);
      assert.ok(result.has('From Proposal Mini'));
      assert.equal(result.size, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('reads from tasks.md by default', () => {
    const dir = join(tmpdir(), `rsc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'tasks.md'), '## Removed Scenarios\n- From Tasks\n', 'utf8');
    try {
      const result = collectRemovedScenarios(dir);
      assert.ok(result.has('From Tasks'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('reads from decisions.md by default', () => {
    const dir = join(tmpdir(), `rsc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'decisions.md'), '## Removed Scenarios\n- `From Decisions`\n', 'utf8');
    try {
      const result = collectRemovedScenarios(dir);
      assert.ok(result.has('From Decisions'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('unions titles from multiple candidate files', () => {
    const dir = join(tmpdir(), `rsc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'proposal-mini.md'), '## Removed Scenarios\n- "Alpha"\n', 'utf8');
    writeFileSync(join(dir, 'tasks.md'), '## Removed Scenarios\n- "Beta"\n', 'utf8');
    writeFileSync(join(dir, 'decisions.md'), '## Removed Scenarios\n- "Gamma"\n', 'utf8');
    try {
      const result = collectRemovedScenarios(dir);
      assert.ok(result.has('Alpha'));
      assert.ok(result.has('Beta'));
      assert.ok(result.has('Gamma'));
      assert.equal(result.size, 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('gracefully skips missing candidate files without error', () => {
    const dir = join(tmpdir(), `rsc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    // Only write proposal.md; others are absent
    writeFileSync(join(dir, 'proposal.md'), '## Removed Scenarios\n- "Only One"\n', 'utf8');
    try {
      const result = collectRemovedScenarios(dir);
      assert.ok(result.has('Only One'));
      assert.equal(result.size, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('accepts custom candidates list', () => {
    const dir = join(tmpdir(), `rsc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'custom.md'), '## Removed Scenarios\n- "Custom File"\n', 'utf8');
    // Default candidates won't find custom.md
    try {
      const defaultResult = collectRemovedScenarios(dir);
      assert.equal(defaultResult.size, 0, 'default candidates should not pick up custom.md');

      const customResult = collectRemovedScenarios(dir, ['custom.md']);
      assert.ok(customResult.has('Custom File'));
      assert.equal(customResult.size, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('deduplicates identical titles appearing in multiple files', () => {
    const dir = join(tmpdir(), `rsc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'proposal.md'), '## Removed Scenarios\n- "Duplicate"\n', 'utf8');
    writeFileSync(join(dir, 'tasks.md'), '## Removed Scenarios\n- "Duplicate"\n', 'utf8');
    try {
      const result = collectRemovedScenarios(dir);
      assert.equal(result.size, 1, 'duplicates should collapse into a single Set entry');
      assert.ok(result.has('Duplicate'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
