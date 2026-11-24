/**
 * requirement-task-coverage.test.mjs
 *
 * Prove-it for `lib/requirement-task-coverage.mjs` (fix-zero-value-review-rounds
 * R7 / notes item `## 107.`).
 *
 * The defect this module closes is a TIMING one: the Requirement Ledger <->
 * task coverage comparison lived inside `pre-pr-archive-gate.mjs` gate (m) as
 * nested closures reading `openspec/changes/archive/<name>/`, so it could not
 * run until the archive commit already existed. Every disagreement between the
 * ledger and the tasks therefore cost an un-archive / fix / re-archive cycle.
 *
 * Two things must hold for the fix to be worth anything, and both are asserted
 * here:
 *   1. the comparison itself still answers exactly what gate (m) used to answer
 *      (the behavioural cases below), and
 *   2. there is only ONE copy of that answer — a second, independently-written
 *      comparison in the pre-archive lint would let it pass a change the archive
 *      gate then blocks, which is worse than having no pre-archive check at all
 *      (the carrier-anchor cases at the end).
 *
 * gate (m)'s own end-to-end cases (m-6 uncovered row / m-7 unknown ref / m-7b
 * range ref, in pre-pr-archive-gate.test.mjs runner_b) stay green unchanged and
 * are the other half of the evidence: they exercise this module through the
 * real archive gate.
 */

import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir } from './lib/tmp.mjs';
import { lintRequirementCountRatchet } from '../lint-requirement-count-ratchet.mjs';
import { extractRequirementLedger, readRequirementLedger } from '../lib/requirement-ledger.mjs';
import { repoPath } from './lib/repo-root.mjs';
import {
  extractRequirementLedgerSection,
  findLedgerTable,
  collectCoverageLedgerRows,
  extractRequirementRefs,
  compareRequirementTaskCoverage,
  COVERAGE_REQUIRED_DISPOSITIONS,
} from '../lib/requirement-task-coverage.mjs';

const LEDGER_HEADER =
  '| ID | Root Requirement | Parent Requirement | Current Requirement | Disposition | Owner / Next Step |\n' +
  '|---|---|---|---|---|---|\n';

function proposalWith(rows) {
  return (
    '# proposal\n\n## Why\n\nbecause\n\n## Requirement Ledger\n\n' +
    LEDGER_HEADER +
    rows.map((r) => `| ${r.join(' | ')} |`).join('\n') +
    '\n\n## Capabilities\n\nnone\n'
  );
}

/** Rows as gate (m) and the lint both derive them, from a proposal body. */
function rowsOf(proposalBody) {
  return collectCoverageLedgerRows(findLedgerTable(extractRequirementLedgerSection(proposalBody)));
}

describe('formal Ledger selection agrees across count and coverage (#2971)', () => {
  const ledger = (n) => proposalWith(Array.from({ length: n }, (_, i) =>
    [`R${i + 1}`, 'user request', 'root', `requirement ${i + 1}`, 'implemented', 'TL']));
  for (const [label, wrap] of [
    ['fenced example', (s) => `\`\`\`markdown\n${s}\n\`\`\`\n`],
    ['commented example', (s) => `<!--\n${s}\n-->\n`],
  ]) {
    test(`${label} before the formal Ledger does not supply task coverage rows`, () => {
      const body = wrap(ledger(9)) + ledger(3);
      const folder = makeTempDir('ledger-selection-');
      try {
        writeFileSync(join(folder, 'proposal.md'), body);
        writeFileSync(join(folder, 'decisions.md'),
          '## D1: initial\n\n## Requirement Baseline Ledger\n' +
          '| decision_id | trigger | baseline_from | baseline_to |\n' +
          '|---|---|---|---|\n| D1 | initial | 0 | 3 |\n');
        const count = lintRequirementCountRatchet({ changeFolder: folder });
        assert.equal(count.pass, true, JSON.stringify(count));
        assert.equal(count.counts.current, 3);
        assert.deepEqual(rowsOf(body).map((r) => r.id), ['R1', 'R2', 'R3']);
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    });
  }

  test('a recognized fence inside the formal section cannot supply its selected table', () => {
    const body = '## Requirement Ledger\n\n```markdown\n' + LEDGER_HEADER +
      '| R9 | r | p | example | implemented | TL |\n```\n\n' + LEDGER_HEADER +
      '| R1 | r | p | actual | implemented | TL |\n';
    assert.deepEqual(rowsOf(body).map((r) => r.id), ['R1']);
  });

  test('an indented next H2 ends the formal Ledger before another table', () => {
    const body = ledger(1).replace('## Capabilities', '  ## Capabilities') +
      LEDGER_HEADER + '| R9 | r | p | unrelated | implemented | TL |\n';
    assert.doesNotMatch(extractRequirementLedgerSection(body), /\| R9 \|/);
  });

  test('two formal Ledger tables require an explicit choice instead of silently counting the first', () => {
    const body = '## Requirement Ledger\n' + LEDGER_HEADER +
      '| R1 | r | p | actual | implemented | TL |\n\n' + LEDGER_HEADER +
      '| R2 | r | p | another formal row | implemented | TL |\n';
    assert.throws(() => extractRequirementLedgerSection(body),
      (err) => err.reason === 'ambiguous-requirement-table');
  });
});

describe('shared formal Ledger reading', () => {
  const body = proposalWith([['R1', 'r', 'p', 'actual', 'implemented', 'TL']]);
  test('the unique live mini Ledger is selected when the earlier carrier contains no Ledger', () => {
    const folder = makeTempDir('ledger-carriers-');
    try {
      writeFileSync(join(folder, 'proposal.md'), '# proposal\nNo Ledger here.\n');
      writeFileSync(join(folder, 'proposal-mini.md'), body);
      const result = readRequirementLedger(folder);
      assert.equal(result.status, 'ok');
      assert.equal(result.file, 'proposal-mini.md');
      assert.deepEqual(result.ids, ['R1']);
      assert.deepEqual(collectCoverageLedgerRows(result.table).map(r => r.id), result.ids);
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });

  test('both live carrier Ledgers are refused before selecting either table', () => {
    const result = extractRequirementLedger([
      { name: 'proposal.md', body }, { name: 'proposal-mini.md', body },
    ]);
    assert.equal(result.status, 'ambiguous-proposal-carrier');
    assert.equal(result.table, undefined);
  });

  test('another pipe table without the formal columns does not grow the requirement count', () => {
    const actual = '## Requirement Ledger\n' + LEDGER_HEADER +
      '| R1 | r | p | actual | implemented | TL |\n\n' +
      '| ID | Example |\n|---|---|\n| R9 | unrelated documentation |\n';
    const result = extractRequirementLedger([{ name: 'proposal.md', body: actual }]);
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.ids, ['R1']);
  });

  test('an illustrative header without a separator cannot supply the formal table failure', () => {
    const actual = '## Requirement Ledger\n| ID | Disposition |\n| incomplete illustration\n\n' +
      LEDGER_HEADER + '| R1 | r | p | actual | implemented | TL |\n';
    const result = extractRequirementLedger([{ name: 'proposal.md', body: actual }]);
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.ids, ['R1']);
  });

  test('the ID column order agrees with the lineage/coverage reader', () => {
    const actual = '## Requirement Ledger\n| Disposition | ID |\n|---|---|\n| implemented | R7 |\n';
    const result = extractRequirementLedger([{ name: 'proposal.md', body: actual }]);
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.ids, ['R7']);
    assert.deepEqual(collectCoverageLedgerRows(result.table).map(r => r.id), ['R7']);
  });

  test('BOM/CRLF and supported heading indentation preserve the same formal rows', () => {
    const actual = ('\uFEFF' + body.replace('## Requirement Ledger', '  ## Requirement Ledger')).replace(/\n/g, '\r\n');
    const result = extractRequirementLedger([{ name: 'proposal.md', body: actual }]);
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.ids, ['R1']);
  });
});

describe('extractRequirementLedgerSection', () => {
  test('absent heading is null, present-but-empty is a string — the two are different faults', () => {
    assert.equal(extractRequirementLedgerSection('# proposal\n\n## Why\n\nbecause\n'), null);
    const empty = extractRequirementLedgerSection('## Requirement Ledger\n\n## Next\n\nbody\n');
    assert.equal(typeof empty, 'string');
    assert.equal(empty.trim(), '');
  });

  test('stops at the next H2 so a later section cannot leak rows into the ledger', () => {
    const section = extractRequirementLedgerSection(
      proposalWith([['R1', 'root', 'root', 'current', 'implemented', 'this PR']])
    );
    assert.match(section, /\| R1 \|/);
    assert.doesNotMatch(section, /Capabilities/);
  });

  test('null-ish input does not throw', () => {
    assert.equal(extractRequirementLedgerSection(undefined), null);
    assert.equal(extractRequirementLedgerSection(null), null);
  });
});

describe('findLedgerTable', () => {
  test('skips a table that lacks the two columns coverage is keyed on', () => {
    const section =
      '\n| Name | Value |\n|---|---|\n| a | b |\n\n' + LEDGER_HEADER + '| R1 | r | p | c | implemented | this PR |\n';
    const table = findLedgerTable(section);
    assert.ok(table, 'the ID + Disposition table must be found past the decoy');
    assert.equal(table.rows.length, 1);
    assert.equal(table.rows[0][0], 'R1');
  });

  test('a bullet-list ledger has no table at all', () => {
    assert.equal(findLedgerTable('\n- R1: implemented\n- R2: deferred\n'), null);
  });

  test('a header row with no separator row underneath is not a table', () => {
    assert.equal(findLedgerTable('\n| ID | Disposition |\n| R1 | implemented |\n'), null);
  });
});

describe('collectCoverageLedgerRows', () => {
  test('numbers data rows from 1 and lowercases the disposition', () => {
    const rows = rowsOf(
      proposalWith([
        ['R1', 'r', 'p', 'c', 'Implemented', 'this PR'],
        ['R2', 'r', 'p', 'c', 'DEFERRED', 'issue #1'],
      ])
    );
    assert.deepEqual(rows, [
      { rowNumber: 1, id: 'R1', disposition: 'implemented' },
      { rowNumber: 2, id: 'R2', disposition: 'deferred' },
    ]);
  });

  test('a missing column yields an empty cell rather than throwing', () => {
    const table = findLedgerTable('\n| ID | Disposition |\n|---|---|\n| R1 | implemented |\n');
    const rows = collectCoverageLedgerRows(table);
    assert.deepEqual(rows, [{ rowNumber: 1, id: 'R1', disposition: 'implemented' }]);
    assert.deepEqual(collectCoverageLedgerRows(null), []);
  });
});

describe('extractRequirementRefs', () => {
  test('collects exact ids, including suffixed ones', () => {
    const { ids, invalidRanges } = extractRequirementRefs(
      '- [x] T1 [Req: R1, R2] done\n- [x] T2 [Req: R4a] done\n'
    );
    assert.deepEqual([...ids], ['R1', 'R2', 'R4a']);
    assert.deepEqual(invalidRanges, []);
  });

  test('a range is recorded AND its endpoints are not harvested as ids', () => {
    const { ids, invalidRanges } = extractRequirementRefs('- [x] T1 [Req: R1-R7] done\n');
    assert.deepEqual(invalidRanges, ['R1-R7']);
    assert.deepEqual([...ids], [], 'R1/R7 must not be read out of the range they bound');
  });

  test('one tag can carry both a range and standalone ids — the author sees both issues', () => {
    const { ids, invalidRanges } = extractRequirementRefs('- [x] T1 [Req: R1-R3, R5] done\n');
    assert.deepEqual(invalidRanges, ['R1-R3']);
    assert.deepEqual([...ids], ['R5']);
  });

  test('text outside a [Req: ...] tag is not a ref', () => {
    const { ids } = extractRequirementRefs('R1 appears in prose, and `R2` in a code span.\n');
    assert.deepEqual([...ids], []);
  });
});

describe('compareRequirementTaskCoverage', () => {
  const ledgerRows = rowsOf(
    proposalWith([
      ['R1', 'r', 'p', 'c', 'implemented', 'this PR'],
      ['R2', 'r', 'p', 'c', 'partial', 'issue #1'],
      ['R3', 'r', 'p', 'c', 'deferred', 'issue #2'],
      ['R4', 'r', 'p', 'c', 'rejected', 'out of scope'],
      ['R5', 'r', 'p', 'c', 'moved-to-issue', 'issue #3'],
    ])
  );

  test('every obliged row claimed and no stray ref → clean', () => {
    const verdict = compareRequirementTaskCoverage({
      ledgerRows,
      taskBody: '- [x] T1 [Req: R1] a\n- [x] T2 [Req: R2] b\n',
    });
    assert.deepEqual(verdict, { invalidRanges: [], unknownRefs: [], uncoveredRows: [] });
  });

  test('only implemented/partial oblige coverage — deferred, rejected and moved-to-issue do not', () => {
    assert.deepEqual([...COVERAGE_REQUIRED_DISPOSITIONS], ['implemented', 'partial']);
    const verdict = compareRequirementTaskCoverage({
      ledgerRows,
      taskBody: '- [x] T1 [Req: R1] a\n',
    });
    assert.deepEqual(verdict.uncoveredRows, [{ rowNumber: 2, id: 'R2', disposition: 'partial' }]);
    assert.deepEqual(verdict.unknownRefs, []);
  });

  test('an uncovered row is reported with the row number the author can find it by', () => {
    const verdict = compareRequirementTaskCoverage({ ledgerRows, taskBody: '- [x] T1 no tags\n' });
    assert.deepEqual(verdict.uncoveredRows, [
      { rowNumber: 1, id: 'R1', disposition: 'implemented' },
      { rowNumber: 2, id: 'R2', disposition: 'partial' },
    ]);
  });

  test('a task ref with no ledger row is reported, in the order the tasks name them', () => {
    const verdict = compareRequirementTaskCoverage({
      ledgerRows,
      taskBody: '- [x] T1 [Req: R1, R9] a\n- [x] T2 [Req: R2, R8] b\n',
    });
    assert.deepEqual(verdict.unknownRefs, ['R9', 'R8']);
    assert.deepEqual(verdict.uncoveredRows, []);
  });

  test('a range in the task ledger is reported and never counts as coverage', () => {
    const verdict = compareRequirementTaskCoverage({ ledgerRows, taskBody: '- [x] T1 [Req: R1-R5] a\n' });
    assert.deepEqual(verdict.invalidRanges, ['R1-R5']);
    assert.deepEqual(
      verdict.uncoveredRows.map((r) => r.id),
      ['R1', 'R2'],
      'a range must not silently satisfy the rows it spans'
    );
  });

  test('a malformed id is skipped on BOTH sides — it is a ledger-shape fault, reported once by its own gate', () => {
    const malformed = rowsOf(proposalWith([['TBD', 'r', 'p', 'c', 'implemented', 'this PR']]));
    const verdict = compareRequirementTaskCoverage({ ledgerRows: malformed, taskBody: '- [x] T1 no tags\n' });
    assert.deepEqual(verdict.uncoveredRows, []);
    assert.deepEqual(verdict.unknownRefs, []);
  });

  test('missing inputs degrade to an empty verdict rather than throwing', () => {
    assert.deepEqual(compareRequirementTaskCoverage({ ledgerRows: undefined, taskBody: undefined }), {
      invalidRanges: [],
      unknownRefs: [],
      uncoveredRows: [],
    });
  });
});

describe('one copy of the answer — carrier anchors', () => {
  const GATE = readFileSync(repoPath('.devpro/scripts/pre-pr-archive-gate.mjs'), 'utf8');
  const LINT = readFileSync(repoPath('.devpro/scripts/lint-proposal-tasks-checked.mjs'), 'utf8');

  test('gate (m) no longer defines its own ref extractor', () => {
    assert.equal(
      (GATE.match(/function extractRequirementRefs/g) || []).length,
      0,
      'pre-pr-archive-gate.mjs must take ref extraction from lib/requirement-task-coverage.mjs, not re-define it'
    );
  });

  test('both the archive gate and the pre-archive lint import the shared module', () => {
    for (const [label, content] of [['pre-pr-archive-gate.mjs', GATE], ['lint-proposal-tasks-checked.mjs', LINT]]) {
      assert.match(
        content,
        /from '\.\/lib\/requirement-task-coverage\.mjs'/,
        `${label} must reach the coverage verdict through the shared module`
      );
      assert.match(
        content,
        /compareRequirementTaskCoverage/,
        `${label} must call the shared bidirectional comparison`
      );
    }
  });

  test('the coverage check is wired at the lint CLI layer, not inside the exported function', () => {
    // archive gate check (o) re-runs `lintProposalTasksChecked` AFTER archive,
    // where gate (m) already reports this violation; folding coverage into the
    // exported function would report one defect twice (design.md D9).
    const exported = LINT.slice(
      LINT.indexOf('export function lintProposalTasksChecked'),
      LINT.indexOf('function lintRequirementTaskCoverage')
    );
    assert.ok(exported.length > 0, 'both functions must exist, in this order');
    assert.doesNotMatch(
      exported,
      /lintRequirementTaskCoverage|compareRequirementTaskCoverage/,
      'the exported lint must not perform the coverage comparison — check (o) reuses it post-archive'
    );
    assert.doesNotMatch(
      LINT,
      /export function lintRequirementTaskCoverage/,
      'the coverage helper must stay unexported so it cannot be re-used post-archive by accident'
    );
  });
});
