/**
 * Unit tests for lint-requirement-count-ratchet.mjs.
 *
 * The ratchet blocks Requirement Ledger row-count growth beyond a baseline that
 * `decisions.md` names in a structured `## Requirement Baseline Ledger` table.
 * It performs zero semantic judgement: it never reads the *reason* a baseline
 * moved, only that a structured, uniquely-identified row says it moved.
 */
import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, statSync, existsSync, renameSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  lintRequirementCountRatchet,
  neutraliseInertMarkdown,
  resolvePriorBaselineRows,
  PROPOSAL_CARRIERS,
} from '../lint-requirement-count-ratchet.mjs';
import {
  collectRequirementIds,
  splitLedgerTableRow,
  hasRequirementId,
} from '../lib/requirement-ledger-rows.mjs';
import { makeTempDir } from './lib/tmp.mjs';
import { SOURCE_ROOT } from './lib/repo-root.mjs';

const SCRIPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(SCRIPTS_DIR, 'lint-requirement-count-ratchet.mjs');

/** Verbatim false-positive prose from enforce-review-remediation-admission/decisions.md:172. */
const PROSE_WITH_SCOPE_CHANGE_TOKEN =
  '- **觸發點**：`openspec-quality-and-formats.md` §Material Semantic Carrier Group Scope Stop-Loss' +
  ' 第 2 點——proposal 初列 groups >10 時，MUST 在**第一次 rule／code write 之前**取得具名批准或拆分。' +
  '本 change 第二次 `scope-change` re-entry 後初列 **11 組**，命中。\n';

/**
 * @param {number} n number of `| R<n> |` rows
 */
function requirementLedger(n) {
  const header =
    '## Requirement Ledger\n\n' +
    '| ID | Root Requirement | Parent Requirement | Current Requirement | Disposition | Owner / Next Step |\n' +
    '|---|---|---|---|---|---|\n';
  let rows = '';
  for (let i = 1; i <= n; i += 1) {
    rows += `| R${i} | root ${i} | — | current ${i} | implemented | TL |\n`;
  }
  return `${header}${rows}\n## Capabilities\n\n無新增 capability。\n`;
}

/**
 * @param {Array<[string, string, number, number]>} rows [decision_id, trigger, from, to]
 */
function baselineLedger(rows) {
  const header =
    '## Requirement Baseline Ledger\n\n' +
    '| decision_id | trigger | baseline_from | baseline_to |\n' +
    '|---|---|---|---|\n';
  return header + rows.map(([d, t, f, to]) => `| ${d} | ${t} | ${f} | ${to} |\n`).join('') + '\n';
}

/**
 * @param {string[]} ids decision ids that get a real `## D<n>:` heading
 */
function decisionHeadings(ids) {
  return ids.map((id) => `## ${id}: fixture decision ${id}\n\n內文。\n\n`).join('');
}

function makeChange(files) {
  const root = makeTempDir('lint-req-ratchet-');
  const changeFolder = join(root, 'openspec', 'changes', 'fixture-change');
  mkdirSync(changeFolder, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(changeFolder, name), body, 'utf8');
  }
  return { root, changeFolder };
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

/** Standard well-formed change with `current` R rows and a baseline of `baseline`. */
function standardChange(current, baseline, extraDecisionsBody = '') {
  return makeChange({
    'proposal.md': `# Proposal\n\n${requirementLedger(current)}`,
    'decisions.md':
      decisionHeadings(['D1']) + baselineLedger([['D1', 'initial', 0, baseline]]) + extraDecisionsBody,
  });
}

function reasons(result) {
  return result.violations.map((v) => v.reason);
}

describe('ratchet formal-table boundary (#2971 review F3)', () => {
  test('Ratchet Refuses A Live Ledger Without A Formal Table', () => {
    const { root, changeFolder } = standardChange(1, 1);
    try {
      writeFileSync(join(changeFolder, 'proposal.md'), '## Requirement Ledger\n| R1 | illustrative row |\n');
      const result = lintRequirementCountRatchet({ changeFolder });
      assert.equal(result.pass, false);
      assert.deepEqual(reasons(result), ['requirement-ledger-table-missing']);
      assert.equal(result.noop, undefined);
    } finally { cleanup(root); }
  });

  test('Ratchet Counts Only The Selected Formal Table', () => {
    const { root, changeFolder } = standardChange(1, 1);
    try {
      const body = requirementLedger(1).replace('\n## Capabilities',
        '\n| R8 | detached row |\n\n| Label | Example |\n|---|---|\n| R9 | unrelated |\n\n## Capabilities');
      assert.match(body, /\| R8 \| detached row \|/);
      assert.match(body, /\| R9 \| unrelated \|/);
      writeFileSync(join(changeFolder, 'proposal.md'), body);
      const result = lintRequirementCountRatchet({ changeFolder });
      assert.equal(result.pass, true, JSON.stringify(result));
      assert.equal(result.counts.current, 1);
    } finally { cleanup(root); }
  });

  test('ambiguous live carriers name both files in the diagnostic', () => {
    const { root, changeFolder } = standardChange(1, 1);
    try {
      writeFileSync(join(changeFolder, 'proposal-mini.md'), requirementLedger(1));
      const result = lintRequirementCountRatchet({ changeFolder });
      assert.equal(result.pass, false);
      assert.deepEqual(reasons(result), ['ambiguous-proposal-carrier']);
      assert.match(result.violations[0].file, /proposal\.md.*proposal-mini\.md/);
    } finally { cleanup(root); }
  });
});

describe('lintRequirementCountRatchet — ratchet decision', () => {
  test('fail: current exceeds baseline, detail names baseline/current/delta', () => {
    const { root, changeFolder } = standardChange(6, 5);
    try {
      const result = lintRequirementCountRatchet({ changeFolder });
      assert.equal(result.pass, false, JSON.stringify(result));
      assert.deepEqual(reasons(result), ['requirement-count-exceeds-baseline']);
      const detail = result.violations[0].detail ?? '';
      for (const n of ['5', '6', '1']) {
        assert.ok(detail.includes(n), `detail must name ${n}: ${detail}`);
      }
      assert.deepEqual(result.counts, { baseline: 5, current: 6, delta: 1 });
    } finally {
      cleanup(root);
    }
  });

  test('pass: current equals baseline', () => {
    const { root, changeFolder } = standardChange(5, 5);
    try {
      assert.equal(lintRequirementCountRatchet({ changeFolder }).pass, true);
    } finally {
      cleanup(root);
    }
  });

  test('pass: current below baseline (shrinking is always allowed)', () => {
    const { root, changeFolder } = standardChange(3, 5);
    try {
      assert.equal(lintRequirementCountRatchet({ changeFolder }).pass, true);
    } finally {
      cleanup(root);
    }
  });

  test('pass: a structured scope-change row raises the baseline', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md': `# Proposal\n\n${requirementLedger(8)}`,
      'decisions.md':
        decisionHeadings(['D1', 'D7']) +
        baselineLedger([
          ['D1', 'initial', 0, 5],
          ['D7', 'scope-change', 5, 9],
        ]),
    });
    try {
      const result = lintRequirementCountRatchet({ changeFolder });
      assert.equal(result.pass, true, JSON.stringify(result));
      assert.equal(result.counts.baseline, 9);
    } finally {
      cleanup(root);
    }
  });
});

describe('lintRequirementCountRatchet — no-op carrier semantics', () => {
  test('no-op: neither proposal.md nor proposal-mini.md exists', () => {
    const { root, changeFolder } = makeChange({ 'brd.md': '# BRD\n' });
    try {
      const result = lintRequirementCountRatchet({ changeFolder });
      assert.equal(result.pass, true, JSON.stringify(result));
      assert.equal(result.noop, 'no-proposal-carrier');
    } finally {
      cleanup(root);
    }
  });

  test('no-op: carrier exists but has no Requirement Ledger section', () => {
    const { root, changeFolder } = makeChange({
      'proposal-mini.md': '# Proposal-mini\n\n## Why\n\n理由。\n',
    });
    try {
      const result = lintRequirementCountRatchet({ changeFolder });
      assert.equal(result.pass, true, JSON.stringify(result));
      assert.equal(result.noop, 'no-requirement-ledger');
    } finally {
      cleanup(root);
    }
  });

  test('proposal-mini.md is resolved when proposal.md is absent', () => {
    const { root, changeFolder } = makeChange({
      'proposal-mini.md': `# Proposal-mini\n\n${requirementLedger(6)}`,
      'decisions.md': decisionHeadings(['D1']) + baselineLedger([['D1', 'initial', 0, 5]]),
    });
    try {
      const result = lintRequirementCountRatchet({ changeFolder });
      assert.equal(result.pass, false, JSON.stringify(result));
      assert.deepEqual(reasons(result), ['requirement-count-exceeds-baseline']);
    } finally {
      cleanup(root);
    }
  });

  test('fail closed: both proposal.md and proposal-mini.md present', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md': `# Proposal\n\n${requirementLedger(3)}`,
      'proposal-mini.md': `# Proposal-mini\n\n${requirementLedger(3)}`,
      'decisions.md': decisionHeadings(['D1']) + baselineLedger([['D1', 'initial', 0, 5]]),
    });
    try {
      const result = lintRequirementCountRatchet({ changeFolder });
      assert.equal(result.pass, false, JSON.stringify(result));
      assert.deepEqual(reasons(result), ['ambiguous-proposal-carrier']);
    } finally {
      cleanup(root);
    }
  });
});

describe('lintRequirementCountRatchet — the clearing path is structural only', () => {
  test('fail: prose containing the literal scope-change token does NOT clear the ratchet', () => {
    // Verbatim false positive from enforce-review-remediation-admission/decisions.md:172.
    const { root, changeFolder } = standardChange(6, 5, `\n${PROSE_WITH_SCOPE_CHANGE_TOKEN}`);
    try {
      const result = lintRequirementCountRatchet({ changeFolder });
      assert.equal(result.pass, false, JSON.stringify(result));
      assert.deepEqual(reasons(result), ['requirement-count-exceeds-baseline']);
      assert.equal(result.counts.baseline, 5, 'prose must not move the baseline');
    } finally {
      cleanup(root);
    }
  });

  test('implementation must not free-text search for the clearing token', () => {
    const source = spawnSync('node', ['-e', 'process.stdout.write(require("fs").readFileSync(process.argv[1],"utf8"))', SCRIPT], {
      encoding: 'utf8',
    }).stdout;
    const freeTextSearch = /(?:includes|indexOf|match|search|test)\s*\([^)]*scope-change/;
    assert.equal(
      freeTextSearch.test(source),
      false,
      'the clearing decision must be table-structural, never a free-text token scan',
    );
  });
});

describe('lintRequirementCountRatchet — baseline ledger integrity', () => {
  test('fail: decisions.md missing while a Requirement Ledger exists', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md': `# Proposal\n\n${requirementLedger(3)}`,
    });
    try {
      const result = lintRequirementCountRatchet({ changeFolder });
      assert.equal(result.pass, false, JSON.stringify(result));
      assert.deepEqual(reasons(result), ['baseline-ledger-missing']);
    } finally {
      cleanup(root);
    }
  });

  test('fail: decisions.md present but carries no baseline ledger heading', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md': `# Proposal\n\n${requirementLedger(3)}`,
      'decisions.md': decisionHeadings(['D1']),
    });
    try {
      const result = lintRequirementCountRatchet({ changeFolder });
      assert.equal(result.pass, false, JSON.stringify(result));
      assert.deepEqual(reasons(result), ['baseline-ledger-missing']);
    } finally {
      cleanup(root);
    }
  });

  test('fail: more than one baseline ledger heading', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md': `# Proposal\n\n${requirementLedger(3)}`,
      'decisions.md':
        decisionHeadings(['D1']) +
        baselineLedger([['D1', 'initial', 0, 5]]) +
        baselineLedger([['D1', 'initial', 0, 9]]),
    });
    try {
      const result = lintRequirementCountRatchet({ changeFolder });
      assert.equal(result.pass, false, JSON.stringify(result));
      assert.deepEqual(reasons(result), ['duplicate-baseline-ledger']);
    } finally {
      cleanup(root);
    }
  });

  test('fail: broken chain — baseline_from does not equal the previous baseline_to', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md': `# Proposal\n\n${requirementLedger(3)}`,
      'decisions.md':
        decisionHeadings(['D1', 'D7']) +
        baselineLedger([
          ['D1', 'initial', 0, 5],
          ['D7', 'scope-change', 6, 9],
        ]),
    });
    try {
      const result = lintRequirementCountRatchet({ changeFolder });
      assert.equal(result.pass, false, JSON.stringify(result));
      assert.deepEqual(reasons(result), ['baseline-chain-broken']);
    } finally {
      cleanup(root);
    }
  });

  test('fail: duplicate decision_id', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md': `# Proposal\n\n${requirementLedger(3)}`,
      'decisions.md':
        decisionHeadings(['D1']) +
        baselineLedger([
          ['D1', 'initial', 0, 5],
          ['D1', 'scope-change', 5, 9],
        ]),
    });
    try {
      const result = lintRequirementCountRatchet({ changeFolder });
      assert.equal(result.pass, false, JSON.stringify(result));
      assert.deepEqual(reasons(result), ['duplicate-baseline-decision-id']);
    } finally {
      cleanup(root);
    }
  });

  test('fail: decision_id has no matching decision heading in decisions.md', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md': `# Proposal\n\n${requirementLedger(3)}`,
      // D1 heading exists; D7 is named by the table but never actually decided.
      'decisions.md':
        decisionHeadings(['D1']) +
        baselineLedger([
          ['D1', 'initial', 0, 5],
          ['D7', 'scope-change', 5, 9],
        ]),
    });
    try {
      const result = lintRequirementCountRatchet({ changeFolder });
      assert.equal(result.pass, false, JSON.stringify(result));
      assert.deepEqual(reasons(result), ['baseline-decision-heading-missing']);
    } finally {
      cleanup(root);
    }
  });

  test('the three integrity reasons are mutually distinct', () => {
    const set = new Set([
      'baseline-chain-broken',
      'duplicate-baseline-decision-id',
      'baseline-decision-heading-missing',
    ]);
    assert.equal(set.size, 3);
  });

  test('fail: first row must be trigger=initial with baseline_from 0', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md': `# Proposal\n\n${requirementLedger(3)}`,
      'decisions.md':
        decisionHeadings(['D1']) + baselineLedger([['D1', 'scope-change', 0, 5]]),
    });
    try {
      const result = lintRequirementCountRatchet({ changeFolder });
      assert.equal(result.pass, false, JSON.stringify(result));
      assert.deepEqual(reasons(result), ['baseline-chain-broken']);
    } finally {
      cleanup(root);
    }
  });

  test('fail: malformed row (non-integer baseline)', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md': `# Proposal\n\n${requirementLedger(3)}`,
      'decisions.md':
        decisionHeadings(['D1']) +
        '## Requirement Baseline Ledger\n\n' +
        '| decision_id | trigger | baseline_from | baseline_to |\n' +
        '|---|---|---|---|\n' +
        '| D1 | initial | 0 | five |\n\n',
    });
    try {
      const result = lintRequirementCountRatchet({ changeFolder });
      assert.equal(result.pass, false, JSON.stringify(result));
      assert.deepEqual(reasons(result), ['baseline-row-malformed']);
    } finally {
      cleanup(root);
    }
  });

  test('fail: unknown trigger token', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md': `# Proposal\n\n${requirementLedger(3)}`,
      'decisions.md':
        decisionHeadings(['D1']) + baselineLedger([['D1', 'because-i-said-so', 0, 5]]),
    });
    try {
      const result = lintRequirementCountRatchet({ changeFolder });
      assert.equal(result.pass, false, JSON.stringify(result));
      assert.deepEqual(reasons(result), ['baseline-row-malformed']);
    } finally {
      cleanup(root);
    }
  });

  test('fail: baseline ledger heading present but table has no data rows', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md': `# Proposal\n\n${requirementLedger(3)}`,
      'decisions.md':
        decisionHeadings(['D1']) +
        '## Requirement Baseline Ledger\n\n' +
        '| decision_id | trigger | baseline_from | baseline_to |\n' +
        '|---|---|---|---|\n\n',
    });
    try {
      const result = lintRequirementCountRatchet({ changeFolder });
      assert.equal(result.pass, false, JSON.stringify(result));
      assert.deepEqual(reasons(result), ['baseline-ledger-empty']);
    } finally {
      cleanup(root);
    }
  });
});

describe('lintRequirementCountRatchet — duplicate requirement ids', () => {
  test('fail: duplicate R ids make the count ambiguous', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md':
        '# Proposal\n\n## Requirement Ledger\n\n' +
        '| ID | Root Requirement | Parent Requirement | Current Requirement | Disposition | Owner / Next Step |\n' +
        '|---|---|---|---|---|---|\n' +
        '| R1 | a | — | a | implemented | TL |\n' +
        '| R1 | b | — | b | implemented | TL |\n\n',
      'decisions.md': decisionHeadings(['D1']) + baselineLedger([['D1', 'initial', 0, 5]]),
    });
    try {
      const result = lintRequirementCountRatchet({ changeFolder });
      assert.equal(result.pass, false, JSON.stringify(result));
      assert.deepEqual(reasons(result), ['duplicate-requirement-id']);
    } finally {
      cleanup(root);
    }
  });
});

describe('lintRequirementCountRatchet — CLI', () => {
  test('CLI exits 1 and prints the three numbers on violation', () => {
    const { root, changeFolder } = standardChange(6, 5);
    try {
      const run = spawnSync('node', [SCRIPT, changeFolder], { encoding: 'utf8' });
      assert.equal(run.status, 1, run.stdout + run.stderr);
      const out = run.stdout + run.stderr;
      assert.match(out, /requirement-count-exceeds-baseline/);
    } finally {
      cleanup(root);
    }
  });

  test('CLI exits 0 and says no-op when there is no Requirement Ledger', () => {
    const { root, changeFolder } = makeChange({
      'proposal-mini.md': '# Proposal-mini\n\n## Why\n\n理由。\n',
    });
    try {
      const run = spawnSync('node', [SCRIPT, changeFolder], { encoding: 'utf8' });
      assert.equal(run.status, 0, run.stdout + run.stderr);
      assert.match(run.stdout + run.stderr, /no-op/);
    } finally {
      cleanup(root);
    }
  });
});

describe('lintRequirementCountRatchet — fenced examples are never declarations', () => {
  // Regression: a decisions.md that only *illustrates* the schema inside a code
  // fence used to be parsed as a real declaration, so the illustrated number
  // became the effective baseline — a fail-open that let any growth through.
  test('fail: a fenced baseline-ledger example does not declare a baseline', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md': `# Proposal\n\n${requirementLedger(3)}`,
      'decisions.md':
        decisionHeadings(['D1']) +
        '說明格式如下（僅為文件範例）：\n\n```\n' +
        baselineLedger([['D1', 'initial', 0, 99]]) +
        '```\n',
    });
    try {
      const result = lintRequirementCountRatchet({ changeFolder });
      assert.equal(result.pass, false, JSON.stringify(result));
      assert.deepEqual(reasons(result), ['baseline-ledger-missing']);
    } finally {
      cleanup(root);
    }
  });

  test('a fenced example beside a real table does not read as a duplicate', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md': `# Proposal\n\n${requirementLedger(3)}`,
      'decisions.md':
        decisionHeadings(['D1']) +
        '範例：\n\n```\n' +
        baselineLedger([['D1', 'initial', 0, 99]]) +
        '```\n\n' +
        baselineLedger([['D1', 'initial', 0, 5]]),
    });
    try {
      const result = lintRequirementCountRatchet({ changeFolder });
      assert.equal(result.pass, true, JSON.stringify(result));
      assert.equal(result.counts.baseline, 5, 'the real table wins, not the illustration');
    } finally {
      cleanup(root);
    }
  });

  /**
   * A fenced ledger is inert to THIS lint but not to archive gate (m), whose
   * locator is not fence-aware. Reading it as "no ledger" therefore handed out
   * a bypass cheaper than the declared one: 20 requirements, no baseline row,
   * exit 0 — while gate (m) counted all 20. Refuse the shape instead.
   */
  test('a Requirement Ledger that exists only inside a fence is refused, not read as absent', () => {
    const { root, changeFolder } = makeChange({
      'proposal-mini.md':
        '# Proposal-mini\n\n## Why\n\n說明 ledger 長相：\n\n```\n' +
        requirementLedger(20) +
        '```\n',
    });
    try {
      const result = lintRequirementCountRatchet({ changeFolder });
      assert.equal(result.pass, false, JSON.stringify(result));
      assert.deepEqual(reasons(result), ['requirement-ledger-inert-only']);
    } finally {
      cleanup(root);
    }
  });

  test('tilde fences are neutralised the same way as backtick fences', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md': `# Proposal\n\n${requirementLedger(3)}`,
      'decisions.md':
        decisionHeadings(['D1']) +
        '~~~\n' +
        baselineLedger([['D1', 'initial', 0, 99]]) +
        '~~~\n',
    });
    try {
      const result = lintRequirementCountRatchet({ changeFolder });
      assert.equal(result.pass, false, JSON.stringify(result));
      assert.deepEqual(reasons(result), ['baseline-ledger-missing']);
    } finally {
      cleanup(root);
    }
  });
});

describe('lintRequirementCountRatchet — GFM separator tolerance', () => {
  test('a single-dash separator row is a separator, not a malformed data row', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md': `# Proposal\n\n${requirementLedger(3)}`,
      'decisions.md':
        decisionHeadings(['D1']) +
        '## Requirement Baseline Ledger\n\n' +
        '| decision_id | trigger | baseline_from | baseline_to |\n' +
        '|-|-|-|-|\n' +
        '| D1 | initial | 0 | 5 |\n\n',
    });
    try {
      const result = lintRequirementCountRatchet({ changeFolder });
      assert.equal(result.pass, true, JSON.stringify(result));
      assert.equal(result.counts.baseline, 5);
    } finally {
      cleanup(root);
    }
  });
});

describe('lintRequirementCountRatchet — this change dogfoods its own gate', () => {
  /**
   * The folder moves once, at archive time, and this test has to survive that
   * move — a hard-coded active path turns red the moment the change is
   * archived, which is exactly when the evidence matters most. Resolve the
   * active location first, then the archived one, and refuse to run at all if
   * neither exists: a dogfood test that silently stops finding its own subject
   * is worse than no dogfood test, because it still reports green.
   */
  const CHANGE_ID = 'add-requirement-count-ratchet';

  function resolveOwnChangeFolder() {
    const active = join(SOURCE_ROOT, 'openspec', 'changes', CHANGE_ID);
    if (existsSync(active)) return active;
    const archiveRoot = join(SOURCE_ROOT, 'openspec', 'changes', 'archive');
    const archived = existsSync(archiveRoot)
      ? readdirSync(archiveRoot)
          .filter((name) => name.endsWith(`-${CHANGE_ID}`))
          .sort()
      : [];
    assert.ok(
      archived.length > 0,
      `this change must exist either active or archived; found neither under ${archiveRoot}`,
    );
    return join(archiveRoot, archived[archived.length - 1]);
  }

  test('this change passes its own ratchet, active or archived', () => {
    const changeFolder = resolveOwnChangeFolder();
    const result = lintRequirementCountRatchet({ changeFolder });
    assert.equal(result.pass, true, JSON.stringify(result));
    // 6, not 5: the cross-model review's finding 1 required a new mechanism,
    // which is a scope change, so the baseline was raised the only way this
    // gate allows — by APPENDING `| D11 | scope-change | 5 | 6 |`, never by
    // editing the row `a169f44a` already committed.
    assert.equal(result.counts.baseline, 6, JSON.stringify(result));
    assert.equal(result.counts.current, 6, JSON.stringify(result));
  });
});

describe('lintRequirementCountRatchet — requirement id shapes match repo canon', () => {
  /**
   * Requirement growth most often takes the shape of splitting an existing
   * requirement (R4 → R4a / R4b) in response to a review finding. A narrower id
   * shape here would under-count exactly that case and let the ratchet pass.
   */
  test('fail: suffixed and backticked ids count toward the ratchet', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md':
        '# Proposal\n\n## Requirement Ledger\n\n' +
        '| ID | Root Requirement | Parent Requirement | Current Requirement | Disposition | Owner / Next Step |\n' +
        '|---|---|---|---|---|---|\n' +
        '| R1 | root | — | current | implemented | TL |\n' +
        '| R2 | root | — | current | implemented | TL |\n' +
        '| R2a | root | R2 | split out | implemented | TL |\n' +
        '| `R2b` | root | R2 | split out | implemented | TL |\n' +
        '| R3.1 | root | — | current | implemented | TL |\n',
      'decisions.md': decisionHeadings(['D1']) + baselineLedger([['D1', 'initial', 0, 2]]),
    });
    try {
      const result = lintRequirementCountRatchet({ changeFolder });
      assert.equal(result.pass, false, JSON.stringify(result));
      assert.deepEqual(reasons(result), ['requirement-count-exceeds-baseline']);
      assert.deepEqual(result.counts, { baseline: 2, current: 5, delta: 3 });
    } finally {
      cleanup(root);
    }
  });

  /**
   * A row that opens with `|` and omits the closing `|` still renders as a
   * table row, but `splitLedgerTableRow` rejects it. Skipping it silently is
   * fail-OPEN for a ratchet: the requirement disappears from `current` and the
   * growth it represents clears the baseline (r2 finding F-RCR2-11).
   */
  test('a row missing its closing pipe is refused, not skipped', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md':
        '# Proposal\n\n## Requirement Ledger\n\n' +
        '| ID | Root Requirement | Parent Requirement | Current Requirement | Disposition | Owner / Next Step |\n' +
        '|---|---|---|---|---|---|\n' +
        '| R1 | root | — | current | implemented | TL |\n' +
        '| R2 | root | — | current | implemented | TL\n' +
        '| R3 | root | — | current | implemented | TL |\n',
      'decisions.md': decisionHeadings(['D1']) + baselineLedger([['D1', 'initial', 0, 2]]),
    });
    try {
      const result = lintRequirementCountRatchet({ changeFolder });
      assert.equal(result.pass, false, JSON.stringify(result));
      assert.deepEqual(reasons(result), ['malformed-requirement-row']);
    } finally {
      cleanup(root);
    }
  });

  test('duplicate detection also normalises backticks', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md':
        '# Proposal\n\n## Requirement Ledger\n\n' +
        '| ID | Root Requirement | Parent Requirement | Current Requirement | Disposition | Owner / Next Step |\n' +
        '|---|---|---|---|---|---|\n' +
        '| R1 | root | — | current | implemented | TL |\n' +
        '| `R1` | root | — | current | implemented | TL |\n',
      'decisions.md': decisionHeadings(['D1']) + baselineLedger([['D1', 'initial', 0, 5]]),
    });
    try {
      const result = lintRequirementCountRatchet({ changeFolder });
      assert.equal(result.pass, false, JSON.stringify(result));
      assert.deepEqual(reasons(result), ['duplicate-requirement-id']);
    } finally {
      cleanup(root);
    }
  });
});

describe('lintRequirementCountRatchet — the exact boundary shared with archive gate (m)', () => {
  const MIXED_LEDGER_BODY =
    '\n| ID | Root Requirement | Parent Requirement | Current Requirement | Disposition | Owner / Next Step |\n' +
    '|---|---|---|---|---|---|\n' +
    '| R1 | root | — | current | implemented | TL |\n' +
    '| R2a | root | R2 | split | implemented | TL |\n' +
    '| `R3` | root | — | current | implemented | TL |\n' +
    '| R4.1 | root | — | current | implemented | TL |\n' +
    '| ID | header-looking row | — | — | — | — |\n';

  const isSeparator = (cells) => cells.every((cell) => /^:?-{3,}:?$/.test(cell));

  /**
   * SHARED half: the id shape. Whatever the caller does with the rows, the
   * verdict "is this cell a requirement id?" comes from one definition.
   */
  test('the shared id shape classifies the same cells whichever caller asks', () => {
    const firstCells = MIXED_LEDGER_BODY.split('\n')
      .map((line) => splitLedgerTableRow(line))
      .filter((cells) => cells !== null && cells.length > 0)
      .map((cells) => cells[0]);
    assert.deepEqual(firstCells.filter((cell) => hasRequirementId(cell)), ['R1', 'R2a', 'R3', 'R4.1']);
    assert.deepEqual(collectRequirementIds(MIXED_LEDGER_BODY).ids, ['R1', 'R2a', 'R3', 'R4.1']);
  });

  /**
   * NOT-SHARED half, pinned so it cannot be quietly re-claimed as parity.
   *
   * r2 finding F-RCR-06: this file previously asserted "both gates recognise
   * the same rows" by comparing `collectRequirementIds` against a
   * re-implementation written a few lines above it — a test that could only
   * pass. Worse, the property it named is false: on this very fixture gate (m)
   * keeps five data rows (it asks "is there a parseable table with rows?")
   * while the ratchet keeps four ids (it asks "how many requirements?").
   */
  test('totals are NOT shared: rows-in-table and requirement-ids are different questions', () => {
    const parseable = MIXED_LEDGER_BODY.split('\n')
      .map((line) => splitLedgerTableRow(line))
      .filter((cells) => cells !== null && cells.length > 0);
    const separators = parseable.filter((cells) => isSeparator(cells));
    // gate (m) starts after the header row and its separator, then keeps every
    // parseable row until the table ends — including `| ID | header-looking |`.
    const gateRowCount = parseable.length - separators.length - 1;
    assert.equal(gateRowCount, 5);
    assert.equal(collectRequirementIds(MIXED_LEDGER_BODY).ids.length, 4);
  });

  test('the lib header states the boundary instead of claiming the gates agree', () => {
    const lib = readFileSync(join(SCRIPTS_DIR, 'lib', 'requirement-ledger-rows.mjs'), 'utf8');
    assert.ok(lib.includes('NOT SHARED'), 'the lib header must name what is not shared');
    assert.ok(
      !/Two gates now count the same rows/.test(lib),
      'the lib header must not claim the two gates count the same rows',
    );
  });
});

describe('lintRequirementCountRatchet — no consumer re-types a shared definition', () => {
  /**
   * Spellings of the requirement-id shape. Keying acceptance on one literal is
   * exactly what `code-review-cross-carrier.md` forbids: `R\d` returning zero
   * hits proves nothing when `R[0-9]` or `[R]\d` express the same shape. Every
   * entry here is exercised by the detector's own test below, so the list is a
   * tested artifact rather than a hopeful guess.
   */
  const ID_SHAPE_SPELLINGS = Object.freeze([
    String.raw`R\d`,
    'R[0-9]',
    String.raw`[R]\d`,
    String.raw`[Rr]\d`,
    '[R][0-9]',
  ]);

  /** A two-element proposal-carrier list literal, in either quote style. */
  const CARRIER_PAIR_RE = /['"]proposal\.md['"],\s*['"]proposal-mini\.md['"]\s*\]/;

  /**
   * Exemptions are anchored to the full surrounding literal, not to the bare
   * shape. A bare strip is defeated by re-typing the shape with a wider
   * quantifier: strip `R\d{1,3}` out of `R\d{1,3}[A-Za-z0-9._]*` and the
   * remainder no longer contains `R\d`, so the re-typed copy passes. Removing
   * a context that no longer appears exactly once is itself a failure.
   */
  const EXEMPT_CONTEXTS = Object.freeze({
    // Git status letters: here R<n> is a rename similarity score (R100).
    'pre-pr-archive-gate.mjs': [String.raw`/^(?:[ACDMRTUXB?]|R\d{1,3}|C\d{1,3})$/`],
    'run-test-suite.mjs': [String.raw`/^R\d*$/u`],
    // The shared definition itself.
    'lib/requirement-ledger-rows.mjs': ['String.raw`R\\d+[A-Za-z0-9._]*`'],
  });

  /**
   * @param {string} body
   * @param {string[]} exemptContexts
   * @returns {string[]} spellings still present after exemptions are removed
   */
  function reTypedShapes(body, exemptContexts = []) {
    let scrubbed = body;
    for (const context of exemptContexts) {
      const hits = scrubbed.split(context).length - 1;
      assert.equal(hits, 1, `exemption context must appear exactly once, found ${hits}: ${context}`);
      scrubbed = scrubbed.split(context).join('');
    }
    return ID_SHAPE_SPELLINGS.filter((spelling) => scrubbed.includes(spelling));
  }

  /** Every non-test script, so a fifth consumer cannot appear unseen. */
  function scriptFiles() {
    const out = [];
    for (const dir of ['', 'lib', 'hooks', join('hooks', 'lib')]) {
      const abs = dir ? join(SCRIPTS_DIR, dir) : SCRIPTS_DIR;
      if (!existsSync(abs)) continue;
      for (const name of readdirSync(abs)) {
        if (!name.endsWith('.mjs')) continue;
        const full = join(abs, name);
        if (!statSync(full).isFile()) continue;
        out.push({ key: dir ? `${dir.split(sep).join('/')}/${name}` : name, path: full });
      }
    }
    return out;
  }

  test('the detector catches every listed spelling, not just the one in use', () => {
    for (const spelling of ID_SHAPE_SPELLINGS) {
      assert.deepEqual(
        reTypedShapes(`const RE = /${spelling}+/u;`),
        [spelling],
        `detector missed the spelling ${spelling}`,
      );
    }
    assert.deepEqual(reTypedShapes('const RE = /nothing to see/u;'), []);
  });

  test('the detector is not defeated by a wider quantifier on an exempt literal', () => {
    const context = String.raw`/^(?:[ACDMRTUXB?]|R\d{1,3}|C\d{1,3})$/`;
    const body = `${context}\nconst OWN = /` + String.raw`R\d{1,3}[A-Za-z0-9._]*` + '/u;';
    assert.deepEqual(reTypedShapes(body, [context]), [String.raw`R\d`]);
  });

  test('the Git rename exemption only removes its exact status parser', () => {
    const contexts = EXEMPT_CONTEXTS['run-test-suite.mjs'];
    const context = String.raw`/^R\d*$/u`;
    assert.deepEqual(reTypedShapes(context, contexts), []);
    assert.deepEqual(reTypedShapes(`${context}\n` + String.raw`/R\d+/u`, contexts), [String.raw`R\d`]);
    assert.throws(() => reTypedShapes('', contexts), /found 0/);
    assert.throws(() => reTypedShapes(`${context}\n${context}`, contexts), /found 2/);
    assert.throws(() => reTypedShapes(String.raw`/^R\d*[A-Za-z0-9._]*$/u`, contexts), /found 0/);
  });

  test('no script re-types the requirement-id shape', () => {
    for (const file of scriptFiles()) {
      const stray = reTypedShapes(readFileSync(file.path, 'utf8'), EXEMPT_CONTEXTS[file.key] ?? []);
      assert.deepEqual(stray, [], `${file.key} re-types the requirement-id shape: ${stray.join(', ')}`);
    }
  });

  test('no script re-types the proposal-carrier list', () => {
    for (const file of scriptFiles()) {
      if (file.key === 'lib/proposal-carriers.mjs') continue;
      assert.ok(
        !CARRIER_PAIR_RE.test(readFileSync(file.path, 'utf8')),
        `${file.key} re-types the two-element proposal-carrier list`,
      );
    }
    // The detector must actually fire on both quote styles it claims to cover.
    assert.ok(CARRIER_PAIR_RE.test("const c = ['proposal.md', 'proposal-mini.md'];"));
    assert.ok(CARRIER_PAIR_RE.test('const c = ["proposal.md", "proposal-mini.md"];'));
    // Wider lists that merely start with the same two names are different
    // definitions (declaration files, risk-class carriers) and stay untouched.
    assert.ok(!CARRIER_PAIR_RE.test("const c = ['proposal.md', 'proposal-mini.md', 'tasks.md'];"));
  });

  test('the known consumers import the shared definitions rather than declaring their own', () => {
    for (const [file, needle] of [
      // Ratchet consumes the formal reader; row recognition stays in its owner.
      ['lint-requirement-count-ratchet.mjs', './lib/requirement-ledger.mjs'],
      ['lib/requirement-ledger.mjs', './requirement-ledger-rows.mjs'],
      ['pre-pr-archive-gate.mjs', './lib/requirement-ledger-rows.mjs'],
      ['lint-proposal-tasks-checked.mjs', './lib/requirement-ledger-rows.mjs'],
      ['lint-requirement-count-ratchet.mjs', './lib/proposal-carriers.mjs'],
      ['pre-pr-archive-gate.mjs', './lib/proposal-carriers.mjs'],
      ['report-governance-ratio.mjs', './lib/proposal-carriers.mjs'],
    ]) {
      const body = readFileSync(join(SCRIPTS_DIR, file), 'utf8');
      assert.ok(body.includes(needle), `${file} must import ${needle}`);
    }
  });

  test('carrier order is proposal.md first — reversing it would disagree with gate (m)', () => {
    assert.deepEqual([...PROPOSAL_CARRIERS], ['proposal.md', 'proposal-mini.md']);
  });
});

describe('lintRequirementCountRatchet — inert markdown is neutralised at the read boundary', () => {
  test('fail: a decision heading that exists only inside a code fence does not bind', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md': `# Proposal\n\n${requirementLedger(3)}`,
      'decisions.md':
        decisionHeadings(['D1']) +
        '寫法示範：\n\n```markdown\n## D9: 提高 baseline\n```\n\n' +
        baselineLedger([
          ['D1', 'initial', 0, 1],
          ['D9', 'scope-change', 1, 9],
        ]),
    });
    try {
      const result = lintRequirementCountRatchet({ changeFolder });
      assert.equal(result.pass, false, JSON.stringify(result));
      assert.deepEqual(reasons(result), ['baseline-decision-heading-missing']);
      assert.ok((result.violations[0].detail ?? '').includes('D9'));
    } finally {
      cleanup(root);
    }
  });

  test('fail: a baseline ledger commented out in HTML does not declare a baseline', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md': `# Proposal\n\n${requirementLedger(1)}`,
      'decisions.md':
        decisionHeadings(['D1']) +
        `<!--\n${baselineLedger([['D1', 'initial', 0, 99]])}-->\n`,
    });
    try {
      const result = lintRequirementCountRatchet({ changeFolder });
      assert.equal(result.pass, false, JSON.stringify(result));
      assert.deepEqual(reasons(result), ['baseline-ledger-missing']);
    } finally {
      cleanup(root);
    }
  });

  test('fail: a tilde-fenced ledger is refused even when a baseline row exists', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md': `# Proposal\n\n說明格式：\n\n~~~markdown\n${requirementLedger(9)}~~~\n`,
      'decisions.md': decisionHeadings(['D1']) + baselineLedger([['D1', 'initial', 0, 5]]),
    });
    try {
      const result = lintRequirementCountRatchet({ changeFolder });
      assert.equal(result.pass, false, JSON.stringify(result));
      assert.deepEqual(reasons(result), ['requirement-ledger-inert-only']);
    } finally {
      cleanup(root);
    }
  });

  test('fail: a Requirement Ledger that exists only inside an HTML comment is refused', () => {
    const { root, changeFolder } = makeChange({
      'proposal-mini.md': `# Proposal-mini\n\n<!--\n${requirementLedger(30)}-->\n`,
      'decisions.md': decisionHeadings(['D1']) + baselineLedger([['D1', 'initial', 0, 1]]),
    });
    try {
      const result = lintRequirementCountRatchet({ changeFolder });
      assert.equal(result.pass, false, JSON.stringify(result));
      assert.deepEqual(reasons(result), ['requirement-ledger-inert-only']);
    } finally {
      cleanup(root);
    }
  });

  /**
   * This case used to pass, on the reasoning that the refusal was scoped to "no
   * carrier holds a live ledger" and ordered-first resolution would simply skip
   * the carrier without one. That reasoning had the dependency backwards. An
   * inert-only carrier is a disagreement between this lint's reading and the
   * raw text, and gate (m) reads the raw text — so the sibling's count settles
   * nothing. Scoping the refusal to "every carrier is inert" let a real ledger
   * hide behind a live sibling declaring fewer rows, which is exactly the
   * bypass a reviewer reproduced at 9 hidden rows against a 3-row sibling.
   *
   * The cost is paid where it is visible: an author who really does want a
   * fenced example beside a live ledger must keep the example's heading from
   * being an exact '## Requirement Ledger' line. The violation detail says so.
   */
  test('fail: a fenced example beside a live ledger is still refused', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md': `# Proposal\n\n說明格式：\n\n\`\`\`markdown\n${requirementLedger(9)}\`\`\`\n`,
      'proposal-mini.md': `# Proposal-mini\n\n${requirementLedger(2)}`,
      'decisions.md': decisionHeadings(['D1']) + baselineLedger([['D1', 'initial', 0, 5]]),
    });
    try {
      const result = lintRequirementCountRatchet({ changeFolder });
      assert.equal(result.pass, false, JSON.stringify(result));
      assert.deepEqual(reasons(result), ['requirement-ledger-inert-only']);
      assert.equal(result.violations[0].file, 'proposal.md');
    } finally {
      cleanup(root);
    }
  });

  test('neutraliseInertMarkdown preserves line count so line scanning stays aligned', () => {
    const src = 'a\n```\nfenced\nlines\n```\nb\n<!--\ncomment\n-->\nc\n';
    const out = neutraliseInertMarkdown(src);
    assert.equal(out.split('\n').length, src.split('\n').length);
    assert.ok(!out.includes('fenced'));
    assert.ok(!out.includes('comment'));
    assert.ok(out.includes('a') && out.includes('b') && out.includes('c'));
  });
});

describe('lintRequirementCountRatchet — encoding and heading tolerance', () => {
  test('pass: CRLF line endings, a BOM, and indented ATX headings', () => {
    const proposal = `# Proposal\n\n${requirementLedger(2)}`.replace(/\n/g, '\r\n');
    const decisions = (
      decisionHeadings(['D1']) + baselineLedger([['D1', 'initial', 0, 2]])
    )
      .replace(/^## /gmu, '   ## ')
      .replace(/\n/g, '\r\n');
    const { root, changeFolder } = makeChange({
      'proposal.md': proposal,
      'decisions.md': `﻿${decisions}`,
    });
    try {
      const result = lintRequirementCountRatchet({ changeFolder });
      assert.equal(result.pass, true, JSON.stringify(result));
      assert.deepEqual(result.counts, { baseline: 2, current: 2, delta: 0 });
    } finally {
      cleanup(root);
    }
  });
});

describe('lintRequirementCountRatchet — carrier resolution follows repo canon', () => {
  /** `pre-pr-archive-gate.mjs` treats proposal.md as the proposal when both exist. */
  test('pass: proposal.md wins when only it carries a Requirement Ledger', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md': `# Proposal\n\n${requirementLedger(3)}`,
      'proposal-mini.md': '# Mini\n\n## Tasks\n\n- [x] T1 [Req: R1] 驗收: n/a\n',
      'decisions.md': decisionHeadings(['D1']) + baselineLedger([['D1', 'initial', 0, 3]]),
    });
    try {
      const result = lintRequirementCountRatchet({ changeFolder });
      assert.equal(result.pass, true, JSON.stringify(result));
      assert.deepEqual(result.counts, { baseline: 3, current: 3, delta: 0 });
    } finally {
      cleanup(root);
    }
  });

  test('fail: both carriers holding a Requirement Ledger is unresolvable', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md': `# Proposal\n\n${requirementLedger(3)}`,
      'proposal-mini.md': `# Mini\n\n${requirementLedger(1)}`,
      'decisions.md': decisionHeadings(['D1']) + baselineLedger([['D1', 'initial', 0, 3]]),
    });
    try {
      const result = lintRequirementCountRatchet({ changeFolder });
      assert.equal(result.pass, false, JSON.stringify(result));
      assert.deepEqual(reasons(result), ['ambiguous-proposal-carrier']);
    } finally {
      cleanup(root);
    }
  });
});

describe('lint-requirement-count-ratchet CLI — end-to-end exit codes', () => {
  test('exit 1 with a suffixed id over baseline; exit 0 at baseline', () => {
    const over = makeChange({
      'proposal.md':
        '# Proposal\n\n## Requirement Ledger\n\n' +
        '| ID | Root Requirement | Parent Requirement | Current Requirement | Disposition | Owner / Next Step |\n' +
        '|---|---|---|---|---|---|\n' +
        '| R1 | root | — | current | implemented | TL |\n' +
        '| R1a | root | R1 | split | implemented | TL |\n',
      'decisions.md': decisionHeadings(['D1']) + baselineLedger([['D1', 'initial', 0, 1]]),
    });
    try {
      const run = spawnSync(process.execPath, [SCRIPT, over.changeFolder], { encoding: 'utf8' });
      assert.equal(run.status, 1, run.stdout + run.stderr);
      assert.match(run.stderr, /requirement-count-exceeds-baseline/u);
    } finally {
      cleanup(over.root);
    }

    const at = standardChange(2, 2);
    try {
      const run = spawnSync(process.execPath, [SCRIPT, at.changeFolder], { encoding: 'utf8' });
      assert.equal(run.status, 0, run.stdout + run.stderr);
      assert.match(run.stdout, /pass \(baseline=2 current=2\)/u);
    } finally {
      cleanup(at.root);
    }
  });
});

/**
 * A change folder inside a real throwaway Git repo, with an initial commit.
 * The append-only check needs committed history to anchor against, so these
 * fixtures cannot use the plain `makeChange` temp folder.
 *
 * @param {Record<string, string>} initialFiles committed as the first commit
 * @returns {{ root: string, changeFolder: string, baseRef: string, git: (args: string[]) => string }}
 */
function makeGitChange(initialFiles, { folder = join('openspec', 'changes', 'fixture-change') } = {}) {
  const root = makeTempDir('lint-req-ratchet-git-');
  const git = (args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '--quiet', '--initial-branch=main']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  git(['config', 'user.name', 'Fixture']);
  git(['config', 'commit.gpgsign', 'false']);
  // An empty base commit gives the branch a ref that predates the change, the
  // same shape as the immutable anchor SHA a real worktree is created from.
  git(['commit', '--quiet', '--allow-empty', '-m', 'base']);
  const baseRef = git(['rev-parse', 'HEAD']).trim();

  const changeFolder = join(root, folder);
  mkdirSync(changeFolder, { recursive: true });
  for (const [name, body] of Object.entries(initialFiles)) {
    writeFileSync(join(changeFolder, name), body, 'utf8');
  }
  git(['add', '-A']);
  git(['commit', '--quiet', '-m', 'declare the change']);
  return { root, changeFolder, baseRef, git };
}

/** Overwrite a file in an already-committed fixture without committing it. */
function writeInPlace(changeFolder, name, body) {
  writeFileSync(join(changeFolder, name), body, 'utf8');
}

describe('lintRequirementCountRatchet — baseline transitions are append-only', () => {
  test('fail: an existing baseline row is mutated in place, with no new row', () => {
    // The exact defect a cross-model reviewer reproduced: raising the FIRST
    // row's baseline_to leaves a chain that is internally consistent, so
    // within-file validation alone reports pass. Only a trusted prior state
    // can tell that the row used to say something else.
    const { root, changeFolder, baseRef } = makeGitChange({
      'proposal.md': `# Proposal\n\n${requirementLedger(5)}`,
      'decisions.md': decisionHeadings(['D1']) + baselineLedger([['D1', 'initial', 0, 5]]),
    });
    try {
      writeInPlace(changeFolder, 'proposal.md', `# Proposal\n\n${requirementLedger(6)}`);
      writeInPlace(
        changeFolder,
        'decisions.md',
        decisionHeadings(['D1']) + baselineLedger([['D1', 'initial', 0, 6]]),
      );

      const withoutBase = lintRequirementCountRatchet({ changeFolder });
      assert.equal(withoutBase.pass, true, 'count-only mode still sees a consistent chain');

      const result = lintRequirementCountRatchet({ changeFolder, baseRef });
      assert.equal(result.pass, false, JSON.stringify(result));
      assert.deepEqual(reasons(result), ['baseline-ledger-not-append-only']);
      const detail = result.violations[0].detail ?? '';
      assert.ok(detail.includes('D1'), `detail must name the mutated row: ${detail}`);
      assert.ok(detail.includes('5') && detail.includes('6'), `detail must name both values: ${detail}`);
    } finally {
      cleanup(root);
    }
  });

  test('pass: raising the baseline by appending a row is the sanctioned path', () => {
    const { root, changeFolder, baseRef } = makeGitChange({
      'proposal.md': `# Proposal\n\n${requirementLedger(5)}`,
      'decisions.md': decisionHeadings(['D1']) + baselineLedger([['D1', 'initial', 0, 5]]),
    });
    try {
      writeInPlace(changeFolder, 'proposal.md', `# Proposal\n\n${requirementLedger(6)}`);
      writeInPlace(
        changeFolder,
        'decisions.md',
        decisionHeadings(['D1', 'D2']) +
          baselineLedger([
            ['D1', 'initial', 0, 5],
            ['D2', 'scope-change', 5, 6],
          ]),
      );
      const result = lintRequirementCountRatchet({ changeFolder, baseRef });
      assert.equal(result.pass, true, JSON.stringify(result));
      assert.equal(result.priorState, 'found', JSON.stringify(result));
      assert.deepEqual(result.counts, { baseline: 6, current: 6, delta: 0 });
    } finally {
      cleanup(root);
    }
  });

  test('fail: deleting a committed baseline row is not append-only either', () => {
    const { root, changeFolder, baseRef } = makeGitChange({
      'proposal.md': `# Proposal\n\n${requirementLedger(9)}`,
      'decisions.md':
        decisionHeadings(['D1', 'D2']) +
        baselineLedger([
          ['D1', 'initial', 0, 5],
          ['D2', 'scope-change', 5, 9],
        ]),
    });
    try {
      writeInPlace(changeFolder, 'proposal.md', `# Proposal\n\n${requirementLedger(5)}`);
      writeInPlace(
        changeFolder,
        'decisions.md',
        decisionHeadings(['D1']) + baselineLedger([['D1', 'initial', 0, 5]]),
      );
      const result = lintRequirementCountRatchet({ changeFolder, baseRef });
      assert.equal(result.pass, false, JSON.stringify(result));
      assert.deepEqual(reasons(result), ['baseline-ledger-not-append-only']);
      assert.ok(
        (result.violations[0].detail ?? '').includes('D2'),
        'detail must name the dropped row',
      );
    } finally {
      cleanup(root);
    }
  });

  test('pass: the first declaration has no prior state to be append-only against', () => {
    // Nothing committed the ledger before HEAD, so the origin is author-
    // asserted by construction. That is the accepted residual, not a defect.
    const { root, changeFolder, baseRef, git } = makeGitChange({
      'proposal.md': '# Proposal\n\n無 Requirement Ledger。\n',
      'decisions.md': '# Decisions\n\n內文。\n',
    });
    try {
      writeInPlace(changeFolder, 'proposal.md', `# Proposal\n\n${requirementLedger(5)}`);
      writeInPlace(
        changeFolder,
        'decisions.md',
        decisionHeadings(['D1']) + baselineLedger([['D1', 'initial', 0, 5]]),
      );
      const result = lintRequirementCountRatchet({ changeFolder, baseRef });
      assert.equal(result.pass, true, JSON.stringify(result));
      assert.equal(result.priorState, 'absent', JSON.stringify(result));
      assert.ok(git(['rev-parse', 'HEAD']).trim().length === 40);
    } finally {
      cleanup(root);
    }
  });

  test('the anchor crosses the archive rename, so archiving cannot launder a mutation', () => {
    // The ledger was committed at the ACTIVE path; the change is then archived,
    // which renames the folder. Linting the archived folder must still find
    // that anchor. A path-literal anchor would report "no prior state" here and
    // wave the edit through — precisely when the change is being sealed.
    const { root, baseRef, git } = makeGitChange({
      'proposal.md': `# Proposal\n\n${requirementLedger(5)}`,
      'decisions.md': decisionHeadings(['D1']) + baselineLedger([['D1', 'initial', 0, 5]]),
    });
    try {
      const archivedRel = join('openspec', 'changes', 'archive', '2026-09-06-fixture-change');
      mkdirSync(join(root, 'openspec', 'changes', 'archive'), { recursive: true });
      git(['mv', join('openspec', 'changes', 'fixture-change'), archivedRel]);
      git(['commit', '--quiet', '-m', 'archive']);

      const archivedFolder = join(root, archivedRel);
      assert.ok(existsSync(archivedFolder), 'fixture must actually be archived');
      assert.ok(
        !existsSync(join(root, 'openspec', 'changes', 'fixture-change')),
        'the active path must be gone, so only the counterpart pathspec can find the anchor',
      );

      // The anchor is the LATEST snapshot in the committed sequence, so once
      // the rename is itself committed the citation moves to the new path —
      // same rows, both sides chain-verified. What must not change is that the
      // committed ledger is still found across the rename; the uncommitted
      // rename below is the case that isolates the counterpart pathspec.
      const prior = resolvePriorBaselineRows({ changeFolder: archivedFolder, baseRef });
      assert.equal(prior.status, 'found', JSON.stringify(prior));
      assert.equal(prior.path, join(archivedRel, 'decisions.md').split(sep).join('/'), JSON.stringify(prior));
      assert.deepEqual(
        prior.rows.map((r) => [r.decisionId, r.from, r.to]),
        [['D1', 0, 5]],
        'the rows carried across the rename are the ones actually committed',
      );

      writeInPlace(archivedFolder, 'proposal.md', `# Proposal\n\n${requirementLedger(6)}`);
      writeInPlace(
        archivedFolder,
        'decisions.md',
        decisionHeadings(['D1']) + baselineLedger([['D1', 'initial', 0, 6]]),
      );
      const result = lintRequirementCountRatchet({ changeFolder: archivedFolder, baseRef });
      assert.equal(result.pass, false, JSON.stringify(result));
      assert.deepEqual(reasons(result), ['baseline-ledger-not-append-only']);
    } finally {
      cleanup(root);
    }
  });

  test('reopening a change whose ledger was only ever committed under archive still anchors', () => {
    // The mirror of the previous case, and the one a plain path-literal anchor
    // plus its active counterpart both miss: the ledger exists in history ONLY
    // at an archive path, and the folder has since been reopened for a
    // pre-merge re-archive. Losing the anchor here is not a red gate — it is a
    // silent downgrade to "first declaration", which passes.
    const archivedRel = join('openspec', 'changes', 'archive', '2026-09-06-fixture-change');
    const { root, baseRef, git } = makeGitChange(
      {
        'proposal.md': `# Proposal\n\n${requirementLedger(5)}`,
        'decisions.md': decisionHeadings(['D1']) + baselineLedger([['D1', 'initial', 0, 5]]),
      },
      { folder: archivedRel },
    );
    try {
      git(['mv', archivedRel, join('openspec', 'changes', 'fixture-change')]);
      git(['commit', '--quiet', '-m', 'reopen']);
      const activeFolder = join(root, 'openspec', 'changes', 'fixture-change');

      const prior = resolvePriorBaselineRows({ changeFolder: activeFolder, baseRef });
      assert.equal(prior.status, 'found', JSON.stringify(prior));
      // As above: the reopen commit re-commits the same ledger at the active
      // path, and the anchor is the latest snapshot, so it is cited there.
      assert.equal(prior.path, 'openspec/changes/fixture-change/decisions.md', JSON.stringify(prior));
      assert.deepEqual(
        prior.rows.map((r) => [r.decisionId, r.from, r.to]),
        [['D1', 0, 5]],
        'the rows carried across the reopen are the ones actually committed',
      );

      writeInPlace(activeFolder, 'proposal.md', `# Proposal\n\n${requirementLedger(6)}`);
      writeInPlace(
        activeFolder,
        'decisions.md',
        decisionHeadings(['D1']) + baselineLedger([['D1', 'initial', 0, 6]]),
      );
      const result = lintRequirementCountRatchet({ changeFolder: activeFolder, baseRef });
      assert.equal(result.pass, false, JSON.stringify(result));
      assert.deepEqual(reasons(result), ['baseline-ledger-not-append-only']);
    } finally {
      cleanup(root);
    }
  });

  test('fail closed: a base ref was demanded but cannot be resolved', () => {
    const { root, changeFolder } = makeGitChange({
      'proposal.md': `# Proposal\n\n${requirementLedger(5)}`,
      'decisions.md': decisionHeadings(['D1']) + baselineLedger([['D1', 'initial', 0, 5]]),
    });
    try {
      const result = lintRequirementCountRatchet({ changeFolder, baseRef: 'no-such-ref' });
      assert.equal(result.pass, false, JSON.stringify(result));
      assert.ok(
        (result.error ?? '').includes('no-such-ref'),
        `a demanded-but-unusable ref must fail closed, not silently skip: ${JSON.stringify(result)}`,
      );
    } finally {
      cleanup(root);
    }
  });

  test('without a base ref the lint reports that it did not check, rather than implying it passed', () => {
    const { root, changeFolder } = makeGitChange({
      'proposal.md': `# Proposal\n\n${requirementLedger(5)}`,
      'decisions.md': decisionHeadings(['D1']) + baselineLedger([['D1', 'initial', 0, 5]]),
    });
    try {
      const result = lintRequirementCountRatchet({ changeFolder });
      assert.equal(result.pass, true, JSON.stringify(result));
      assert.equal(result.priorState, 'not-requested', JSON.stringify(result));
    } finally {
      cleanup(root);
    }
  });

  test('CLI: --base is accepted and reports the append-only violation', () => {
    const { root, changeFolder, baseRef } = makeGitChange({
      'proposal.md': `# Proposal\n\n${requirementLedger(5)}`,
      'decisions.md': decisionHeadings(['D1']) + baselineLedger([['D1', 'initial', 0, 5]]),
    });
    try {
      writeInPlace(changeFolder, 'proposal.md', `# Proposal\n\n${requirementLedger(6)}`);
      writeInPlace(
        changeFolder,
        'decisions.md',
        decisionHeadings(['D1']) + baselineLedger([['D1', 'initial', 0, 6]]),
      );
      const run = spawnSync('node', [SCRIPT, changeFolder, '--base', baseRef], { encoding: 'utf8' });
      assert.equal(run.status, 1, run.stdout + run.stderr);
      assert.match(run.stderr, /baseline-ledger-not-append-only/u);
    } finally {
      cleanup(root);
    }
  });
});

describe('lintRequirementCountRatchet — fence recognition follows CommonMark', () => {
  test('a line carrying an info string can open a fence but can never close one', () => {
    // CommonMark: a closing fence "may not have an info string". Treating
    // ```js as a closer ends the block early and hands the rest of the file
    // back as live content — which is how a purely illustrative ledger became
    // a real declaration.
    const src = ['```', 'example line', '```js', '| D1 | initial | 0 | 99 |', '```'].join('\n');
    const lines = neutraliseInertMarkdown(src).split('\n');
    assert.equal(lines[3], '', `the ledger line must stay inert, got ${JSON.stringify(lines[3])}`);
  });

  test('the tilde spelling of the same escape is closed too', () => {
    const src = ['~~~', 'example line', '~~~js', '| D1 | initial | 0 | 99 |', '~~~'].join('\n');
    const lines = neutraliseInertMarkdown(src).split('\n');
    assert.equal(lines[3], '', `the ledger line must stay inert, got ${JSON.stringify(lines[3])}`);
  });

  test('a bare delimiter still closes, including a longer run than the opener', () => {
    const src = ['```', 'inert', '`````', 'live again', '```', 'inert too'].join('\n');
    const lines = neutraliseInertMarkdown(src).split('\n');
    assert.equal(lines[1], '', 'inside the first fence');
    assert.equal(lines[3], 'live again', 'the longer bare run closes the fence');
    assert.equal(lines[5], '', 'and the next bare run opens another');
  });

  test('a shorter run does not close a longer opener', () => {
    const src = ['````', '```', 'still inert', '````', 'live again'].join('\n');
    const lines = neutraliseInertMarkdown(src).split('\n');
    assert.equal(lines[2], '', 'a shorter run is content, not a closer');
    assert.equal(lines[4], 'live again');
  });

  test('malformed <!--> stays unclosed (fail closed; opener-length offset)', () => {
    const src = ['before <!--> still comment', 'after closer --> live', 'done'].join('\n');
    const lines = neutraliseInertMarkdown(src).split('\n');
    // `<!-->` must not close at the embedded `-->` inside the opener; line0
    // remainder stays blanked, and inComment continues until a real closer.
    assert.match(lines[0], /^before\s+$/, `opener line live prefix only, got ${JSON.stringify(lines[0])}`);
    assert.equal(lines[0].includes('still comment'), false, 'text after <!--> must stay inert');
    assert.equal(lines[1].trim(), 'live', `real --> closes; got ${JSON.stringify(lines[1])}`);
    assert.equal(lines[2], 'done');
    const lib = readFileSync(join(SCRIPTS_DIR, 'lib/markdown-fence-aware.mjs'), 'utf8');
    assert.match(lib, /HTML_COMMENT_OPEN_LEN\s*=\s*4/, 'named opener-length constant');
    assert.match(lib, /indexOf\(["']-->["'],\s*HTML_COMMENT_OPEN_LEN\)/, 'close search uses named offset');
  });

  test('a backtick fence whose info string contains a backtick is not a fence at all', () => {
    // CommonMark forbids backticks in a backtick-fence info string. Reading
    // such a line as an opener would blank live content below it — and a
    // ledger that disappears reads to this lint as "no ledger", which passes.
    const src = ['```a`b', '| D1 | initial | 0 | 99 |'].join('\n');
    const lines = neutraliseInertMarkdown(src).split('\n');
    assert.equal(lines[1], '| D1 | initial | 0 | 99 |', 'content below a non-fence stays live');
  });

  test('an inert-only baseline ledger behind an info-string escape is refused end to end', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md': `# Proposal\n\n${requirementLedger(5)}`,
      'decisions.md':
        decisionHeadings(['D1']) +
        '```\n範例：\n```js\n' +
        '## Requirement Baseline Ledger\n\n' +
        '| decision_id | trigger | baseline_from | baseline_to |\n' +
        '|---|---|---|---|\n' +
        '| D1 | initial | 0 | 99 |\n' +
        '```\n',
    });
    try {
      const result = lintRequirementCountRatchet({ changeFolder });
      assert.equal(result.pass, false, JSON.stringify(result));
      assert.deepEqual(reasons(result), ['baseline-ledger-missing']);
    } finally {
      cleanup(root);
    }
  });
});

describe('lintRequirementCountRatchet — an HTML comment occupies its columns', () => {
  test('a heading pushed off column 0 by a comment is not a heading', () => {
    // Markdown renders `<!-- x --> ## H` as a paragraph, not a heading: an ATX
    // heading must start within three columns. Deleting the comment outright
    // manufactures a declaration the reader never sees.
    const { root, changeFolder } = makeChange({
      'proposal.md': `# Proposal\n\n${requirementLedger(5)}`,
      'decisions.md':
        decisionHeadings(['D1']) +
        '<!-- 範例 --> ## Requirement Baseline Ledger\n\n' +
        '| decision_id | trigger | baseline_from | baseline_to |\n' +
        '|---|---|---|---|\n' +
        '| D1 | initial | 0 | 99 |\n',
    });
    try {
      const result = lintRequirementCountRatchet({ changeFolder });
      assert.equal(result.pass, false, JSON.stringify(result));
      assert.deepEqual(reasons(result), ['baseline-ledger-missing']);
    } finally {
      cleanup(root);
    }
  });

  test('a trailing comment after a real heading leaves the heading intact', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md': `# Proposal\n\n${requirementLedger(5)}`,
      'decisions.md':
        decisionHeadings(['D1']) +
        '## Requirement Baseline Ledger <!-- 註 -->\n\n' +
        '| decision_id | trigger | baseline_from | baseline_to |\n' +
        '|---|---|---|---|\n' +
        '| D1 | initial | 0 | 5 |\n',
    });
    try {
      const result = lintRequirementCountRatchet({ changeFolder });
      assert.equal(result.pass, true, JSON.stringify(result));
      assert.deepEqual(result.counts, { baseline: 5, current: 5, delta: 0 });
    } finally {
      cleanup(root);
    }
  });

  test('line count is still preserved when a multi-line comment is blanked', () => {
    const src = ['live one', '<!-- a', 'b', 'c -->', 'live two'].join('\n');
    const lines = neutraliseInertMarkdown(src).split('\n');
    assert.equal(lines.length, 5, JSON.stringify(lines));
    assert.equal(lines[0], 'live one');
    assert.equal(lines[4], 'live two');
    assert.equal(lines[2].trim(), '', 'comment interior carries no live content');
  });
});

/**
 * Regressions for the r3 cross-model finding: neutralisation must respect the
 * markdown state it is already in. Blanking every `<!--` before recognising
 * fences meant an unterminated comment *inside an illustrative fence* swallowed
 * the rest of the file, and everything downstream then read "no ledger".
 *
 * The opposite direction — a fence delimiter inside a real comment is not a
 * fence — is locked by the `an HTML comment occupies its columns` suite above,
 * so a fix that merely swaps the two passes cannot satisfy both.
 */
describe('lintRequirementCountRatchet — an unterminated comment inside a fence is code', () => {
  /** A fenced markdown example whose body opens a comment it never closes. */
  const POISON_FENCE = ['```markdown', '<!-- 示範：被註解掉的 baseline', '```', ''].join('\n');

  test('the fence closes and live content below it survives', () => {
    const src = POISON_FENCE + '## Requirement Baseline Ledger\n';
    const lines = neutraliseInertMarkdown(src).split('\n');
    assert.equal(lines[1], '', 'the comment-looking line is fence content');
    assert.equal(
      lines[3],
      '## Requirement Baseline Ledger',
      `content below the closing fence must stay live, got ${JSON.stringify(lines[3])}`,
    );
  });

  test('a baseline declared below such a fence still binds', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md': `# Proposal\n\n${requirementLedger(6)}`,
      'decisions.md':
        decisionHeadings(['D1']) + POISON_FENCE + baselineLedger([['D1', 'initial', 0, 5]]),
    });
    try {
      // Before the fix the baseline vanished with the rest of the file, so the
      // lint reported the no-op pass instead of counting 6 against 5.
      const result = lintRequirementCountRatchet({ changeFolder });
      assert.equal(result.pass, false, JSON.stringify(result));
      assert.deepEqual(reasons(result), ['requirement-count-exceeds-baseline']);
      assert.deepEqual(result.counts, { baseline: 5, current: 6, delta: 1 });
    } finally {
      cleanup(root);
    }
  });

  test('fail: the poisoned carrier cannot hide behind a low-count sibling', () => {
    // The dual-carrier shape of the same defect: swallow the real 9-row ledger
    // in proposal.md and leave a 3-row ledger in proposal-mini.md, and carrier
    // selection used to see exactly one live ledger and pass at 3 === 3.
    const { root, changeFolder } = makeChange({
      'proposal.md': `# Proposal\n\n${POISON_FENCE}${requirementLedger(9)}`,
      'proposal-mini.md': `# Proposal-mini\n\n${requirementLedger(3)}`,
      'decisions.md': decisionHeadings(['D1']) + baselineLedger([['D1', 'initial', 0, 3]]),
    });
    try {
      const result = lintRequirementCountRatchet({ changeFolder });
      assert.equal(result.pass, false, JSON.stringify(result));
      assert.deepEqual(reasons(result), ['ambiguous-proposal-carrier']);
    } finally {
      cleanup(root);
    }
  });

  test('fail: a poisoned committed decisions.md does not downgrade the Git anchor', () => {
    // The highest-severity path: with the prior baseline unreadable the
    // resolver reported `absent`, which skips the append-only check entirely —
    // so an in-place rewrite of an already-committed row went through, and the
    // poisoned file then became the anchor for everything after it.
    const { root, changeFolder, baseRef } = makeGitChange({
      'proposal.md': `# Proposal\n\n${requirementLedger(5)}`,
      'decisions.md':
        decisionHeadings(['D1']) + POISON_FENCE + baselineLedger([['D1', 'initial', 0, 5]]),
    });
    try {
      writeInPlace(changeFolder, 'proposal.md', `# Proposal\n\n${requirementLedger(24)}`);
      writeInPlace(
        changeFolder,
        'decisions.md',
        decisionHeadings(['D1']) + POISON_FENCE + baselineLedger([['D1', 'initial', 0, 24]]),
      );

      const prior = resolvePriorBaselineRows({ changeFolder, baseRef });
      assert.equal(prior.status, 'found', `the anchor must still resolve: ${JSON.stringify(prior)}`);

      const result = lintRequirementCountRatchet({ changeFolder, baseRef });
      assert.equal(result.pass, false, JSON.stringify(result));
      assert.equal(result.priorState, 'found', JSON.stringify(result));
      assert.deepEqual(reasons(result), ['baseline-ledger-not-append-only']);
    } finally {
      cleanup(root);
    }
  });
});

/**
 * Round 3 found the recogniser gap again, in a third construct: an inline code
 * span. `\`<!--\`` in ordinary prose was read as a comment opener, so everything
 * after it went dark — and the two consumers of that dark region each had a way
 * to call the silence normal. Carrier selection called it "this carrier has no
 * ledger" and deferred to a sibling; the Git anchor resolver called it "this
 * branch has not declared a baseline" and switched the append-only check off.
 *
 * Three rounds, three constructs, one class. So the fix here is not a fourth
 * construct: it is to stop treating "this lint cannot read it" as evidence
 * about the file. Both consumers now fail closed on that state, which turns
 * every remaining recogniser gap from a silent bypass into a loud refusal.
 */
describe('lintRequirementCountRatchet — unreadable is not absent', () => {
  /** Ordinary prose that names the comment opener inside an inline code span. */
  const POISON_SPAN = '說明：以 \`<!--\` 起始即可註解掉整段。\n\n';

  const MALFORMED_LEDGER = [
    '## Requirement Baseline Ledger',
    '',
    '| decision_id | trigger | baseline_from | baseline_to |',
    '|---|---|---|---|',
    '| D1 | initial | 0 |',
    '',
    '',
  ].join('\n');

  test('fail: a code span cannot hide a carrier behind a lower-count sibling', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md': `# Proposal\n\n${POISON_SPAN}${requirementLedger(9)}`,
      'proposal-mini.md': `# Proposal-mini\n\n${requirementLedger(3)}`,
      'decisions.md': decisionHeadings(['D1']) + baselineLedger([['D1', 'initial', 0, 3]]),
    });
    try {
      // Reproduced as pass=true at counts {baseline:3, current:3, delta:0}
      // while proposal.md carried nine requirements.
      const result = lintRequirementCountRatchet({ changeFolder });
      assert.equal(result.pass, false, JSON.stringify(result));
      assert.deepEqual(reasons(result), ['requirement-ledger-inert-only']);
      assert.equal(result.violations[0].file, 'proposal.md');
    } finally {
      cleanup(root);
    }
  });

  test('the refusal names the construct so the author can find it', () => {
    const { root, changeFolder } = makeChange({
      'proposal.md': `# Proposal\n\n${POISON_SPAN}${requirementLedger(4)}`,
      'decisions.md': decisionHeadings(['D1']) + baselineLedger([['D1', 'initial', 0, 4]]),
    });
    try {
      const result = lintRequirementCountRatchet({ changeFolder });
      assert.match(result.violations[0].detail, /inline code span/u);
    } finally {
      cleanup(root);
    }
  });

  test('fail: an unreadable committed baseline ledger is not a missing one', () => {
    // The highest-severity path, in the reviewer's exact shape: poison only the
    // committed decisions.md, then de-poison the working tree and rewrite an
    // already-committed row. The resolver used to answer `absent`, which is the
    // answer reserved for a branch with no baseline yet, so the append-only
    // check never ran and 5 -> 24 went through.
    const { root, changeFolder, baseRef } = makeGitChange({
      'proposal.md': `# Proposal\n\n${requirementLedger(5)}`,
      'decisions.md':
        decisionHeadings(['D1']) + POISON_SPAN + baselineLedger([['D1', 'initial', 0, 5]]),
    });
    try {
      writeInPlace(changeFolder, 'proposal.md', `# Proposal\n\n${requirementLedger(24)}`);
      writeInPlace(
        changeFolder,
        'decisions.md',
        decisionHeadings(['D1']) + baselineLedger([['D1', 'initial', 0, 24]]),
      );

      const prior = resolvePriorBaselineRows({ changeFolder, baseRef });
      assert.equal(prior.status, 'unavailable', JSON.stringify(prior));
      assert.match(prior.detail, /could not read/u);

      const result = lintRequirementCountRatchet({ changeFolder, baseRef });
      assert.equal(result.pass, false, JSON.stringify(result));
      assert.equal(result.priorState, 'unavailable', JSON.stringify(result));
    } finally {
      cleanup(root);
    }
  });

  test('absent still means absent: a branch that has declared no baseline', () => {
    // The legitimate downgrade the refusal must not swallow — a first
    // declaration, or an archive rename that moved the file out of the
    // pathspec. Nothing was ever committed under a decisions path here.
    const { root, changeFolder, baseRef } = makeGitChange({
      'proposal.md': `# Proposal\n\n${requirementLedger(2)}`,
    });
    try {
      writeInPlace(
        changeFolder,
        'decisions.md',
        decisionHeadings(['D1']) + baselineLedger([['D1', 'initial', 0, 2]]),
      );
      const prior = resolvePriorBaselineRows({ changeFolder, baseRef });
      assert.equal(prior.status, 'absent', JSON.stringify(prior));
    } finally {
      cleanup(root);
    }
  });

  test('a work-in-progress ledger still yields to a later valid one', () => {
    // "Earliest valid" is unchanged: the refusal only fires once the whole
    // range is exhausted, so an early malformed ledger is still skipped in
    // favour of the valid one committed after it.
    const { root, changeFolder, baseRef, git } = makeGitChange({
      'proposal.md': `# Proposal\n\n${requirementLedger(2)}`,
      'decisions.md': decisionHeadings(['D1']) + MALFORMED_LEDGER,
    });
    try {
      writeInPlace(
        changeFolder,
        'decisions.md',
        decisionHeadings(['D1']) + baselineLedger([['D1', 'initial', 0, 2]]),
      );
      git(['add', '-A']);
      git(['commit', '--quiet', '-m', 'fix the ledger']);

      const prior = resolvePriorBaselineRows({ changeFolder, baseRef });
      assert.equal(prior.status, 'found', JSON.stringify(prior));
      assert.deepEqual(prior.rows.map((r) => r.decisionId), ['D1']);
    } finally {
      cleanup(root);
    }
  });
});

/**
 * Round 4 found that anchoring on the EARLIEST valid committed ledger protects
 * only the rows that ledger held. Commit A declares D1, commit B validly
 * appends D2, and a later state then edits or deletes D2 while keeping D1: the
 * result still extends A, so it passed. Reproduced at 8 -> 30 requirements
 * through an in-place edit and at 8 -> 40 through a delete-and-re-append.
 *
 * This is a defect in the anchor design itself (decisions.md D11's "earliest
 * valid"), not in the markdown recogniser the first four rounds circled. The
 * fix verifies the whole committed sequence and anchors on its last member.
 */
describe('lintRequirementCountRatchet — every committed row is immutable, not just the first', () => {
  /** Commit A declares D1; commit B validly appends D2. */
  function twoCommitChain() {
    const fixture = makeGitChange({
      'proposal.md': `# Proposal\n\n${requirementLedger(5)}`,
      'decisions.md': decisionHeadings(['D1']) + baselineLedger([['D1', 'initial', 0, 5]]),
    });
    writeInPlace(fixture.changeFolder, 'proposal.md', `# Proposal\n\n${requirementLedger(8)}`);
    writeInPlace(
      fixture.changeFolder,
      'decisions.md',
      decisionHeadings(['D1', 'D2']) +
        baselineLedger([['D1', 'initial', 0, 5], ['D2', 'scope-change', 5, 8]]),
    );
    fixture.git(['add', '-A']);
    fixture.git(['commit', '--quiet', '-m', 'append D2']);
    return fixture;
  }

  test('pass: the control — a legitimate two-commit append chain', () => {
    const { root, changeFolder, baseRef } = twoCommitChain();
    try {
      const prior = resolvePriorBaselineRows({ changeFolder, baseRef });
      assert.equal(prior.status, 'found', JSON.stringify(prior));
      assert.deepEqual(
        prior.rows.map((r) => r.decisionId),
        ['D1', 'D2'],
        'the anchor must be the LATEST committed ledger, not the earliest',
      );

      const result = lintRequirementCountRatchet({ changeFolder, baseRef });
      assert.equal(result.pass, true, JSON.stringify(result));
    } finally {
      cleanup(root);
    }
  });

  test('fail: a row appended by a later commit cannot be edited in place', () => {
    const { root, changeFolder, baseRef } = twoCommitChain();
    try {
      // Reproduced as pass=true at counts {baseline:30, current:30, delta:0}.
      writeInPlace(changeFolder, 'proposal.md', `# Proposal\n\n${requirementLedger(30)}`);
      writeInPlace(
        changeFolder,
        'decisions.md',
        decisionHeadings(['D1', 'D2']) +
          baselineLedger([['D1', 'initial', 0, 5], ['D2', 'scope-change', 5, 30]]),
      );
      const result = lintRequirementCountRatchet({ changeFolder, baseRef });
      assert.equal(result.pass, false, JSON.stringify(result));
      assert.deepEqual(reasons(result), ['baseline-ledger-not-append-only']);
    } finally {
      cleanup(root);
    }
  });

  test('fail: a row appended by a later commit cannot be deleted', () => {
    const { root, changeFolder, baseRef } = twoCommitChain();
    try {
      // Reproduced as pass=true at counts {baseline:40, current:40, delta:0}:
      // drop the committed D2 and re-append a different row in its place.
      writeInPlace(changeFolder, 'proposal.md', `# Proposal\n\n${requirementLedger(40)}`);
      writeInPlace(
        changeFolder,
        'decisions.md',
        decisionHeadings(['D1', 'D9']) +
          baselineLedger([['D1', 'initial', 0, 5], ['D9', 'scope-change', 5, 40]]),
      );
      const result = lintRequirementCountRatchet({ changeFolder, baseRef });
      assert.equal(result.pass, false, JSON.stringify(result));
      assert.deepEqual(reasons(result), ['baseline-ledger-not-append-only']);
    } finally {
      cleanup(root);
    }
  });

  test('fail: the committed sequence itself must be append-only', () => {
    // The rewrite is already in history rather than in the working tree. It is
    // the same violation, so it carries the same reason — and the detail names
    // both commits, because the remediation is a history fix, not a file edit.
    const { root, changeFolder, baseRef, git } = makeGitChange({
      'proposal.md': `# Proposal\n\n${requirementLedger(5)}`,
      'decisions.md': decisionHeadings(['D1']) + baselineLedger([['D1', 'initial', 0, 5]]),
    });
    try {
      writeInPlace(changeFolder, 'proposal.md', `# Proposal\n\n${requirementLedger(9)}`);
      writeInPlace(
        changeFolder,
        'decisions.md',
        decisionHeadings(['D1']) + baselineLedger([['D1', 'initial', 0, 9]]),
      );
      git(['add', '-A']);
      git(['commit', '--quiet', '-m', 'quietly raise D1 in a second commit']);

      const prior = resolvePriorBaselineRows({ changeFolder, baseRef });
      assert.equal(prior.status, 'history-not-append-only', JSON.stringify(prior));
      assert.match(prior.detail, /already committed on this branch/u);

      const result = lintRequirementCountRatchet({ changeFolder, baseRef });
      assert.equal(result.pass, false, JSON.stringify(result));
      assert.deepEqual(reasons(result), ['baseline-ledger-not-append-only']);
      assert.equal(result.priorState, 'history-not-append-only', JSON.stringify(result));
    } finally {
      cleanup(root);
    }
  });

  test('the anchor survives an archive rename that is not yet committed', () => {
    // The case the two committed-rename tests above no longer isolate: pre-PR
    // runs `openspec archive` and then the gates, so the folder sits at its
    // archived path while history still only knows the active one. Only the
    // counterpart pathspec can reach the anchor here — drop it and this fixture
    // resolves to `absent`, which passes the mutation through.
    const { root, changeFolder, baseRef } = makeGitChange({
      'proposal.md': `# Proposal\n\n${requirementLedger(5)}`,
      'decisions.md': decisionHeadings(['D1']) + baselineLedger([['D1', 'initial', 0, 5]]),
    });
    try {
      const archivedRel = join('openspec', 'changes', 'archive', '2026-09-06-fixture-change');
      const archivedFolder = join(root, archivedRel);
      mkdirSync(join(root, 'openspec', 'changes', 'archive'), { recursive: true });
      renameSync(changeFolder, archivedFolder); // working tree only — never committed

      const prior = resolvePriorBaselineRows({ changeFolder: archivedFolder, baseRef });
      assert.equal(prior.status, 'found', JSON.stringify(prior));
      assert.equal(prior.path, 'openspec/changes/fixture-change/decisions.md', JSON.stringify(prior));

      writeInPlace(archivedFolder, 'proposal.md', `# Proposal\n\n${requirementLedger(6)}`);
      writeInPlace(
        archivedFolder,
        'decisions.md',
        decisionHeadings(['D1']) + baselineLedger([['D1', 'initial', 0, 6]]),
      );
      const result = lintRequirementCountRatchet({ changeFolder: archivedFolder, baseRef });
      assert.equal(result.pass, false, JSON.stringify(result));
      assert.deepEqual(reasons(result), ['baseline-ledger-not-append-only']);
    } finally {
      cleanup(root);
    }
  });
});

describe('lintRequirementCountRatchet — an unreadable snapshot after the anchor fails closed', () => {
  // A decisions.md whose baseline ledger survives in the raw bytes but not in
  // the view this lint reads. The construct used here is a code fence, but the
  // point of these tests is that the ANSWER must not depend on which construct
  // it was: the set this recogniser mishandles is unbounded, so "I could not
  // read it" must never be answered with a silently older anchor.
  function hidden(body) {
    return '# Decisions\n\n```markdown\n' + body + '```\n';
  }

  const D1_ONLY = decisionHeadings(['D1']) + baselineLedger([['D1', 'initial', 0, 5]]);
  const D1_D2 =
    decisionHeadings(['D1', 'D2']) +
    baselineLedger([['D1', 'initial', 0, 5], ['D2', 'scope-change', 5, 8]]);

  /** Commit A declares a readable ledger; commit B appends a row this lint cannot read. */
  function validThenUnreadable() {
    const fixture = makeGitChange({
      'proposal.md': `# Proposal\n\n${requirementLedger(5)}`,
      'decisions.md': D1_ONLY,
    });
    writeInPlace(fixture.changeFolder, 'proposal.md', `# Proposal\n\n${requirementLedger(8)}`);
    writeInPlace(fixture.changeFolder, 'decisions.md', hidden(D1_D2));
    fixture.git(['add', '-A']);
    fixture.git(['commit', '--quiet', '-m', 'append D2, unreadable to this lint']);
    return fixture;
  }

  test('fail: a valid anchor followed by an unreadable snapshot is unavailable, not found', () => {
    const { root, changeFolder, baseRef } = validThenUnreadable();
    try {
      const prior = resolvePriorBaselineRows({ changeFolder, baseRef });
      assert.equal(
        prior.status,
        'unavailable',
        'anchoring at the last READABLE snapshot silently discards every row the ' +
          `unreadable one committed: ${JSON.stringify(prior)}`,
      );
    } finally {
      cleanup(root);
    }
  });

  test('fail: the row the unreadable commit appended cannot then be deleted', () => {
    const { root, changeFolder, baseRef } = validThenUnreadable();
    try {
      // The attack the previous assertion protects against: D2 is committed, so
      // it is immutable — but it is only committed inside the snapshot this lint
      // cannot read. Anchoring back at D1 makes deleting it look like an
      // ordinary extension of D1, which is the round-4 violation class reached
      // through unreadability instead of through ordering.
      writeInPlace(changeFolder, 'proposal.md', `# Proposal\n\n${requirementLedger(5)}`);
      writeInPlace(changeFolder, 'decisions.md', D1_ONLY);

      const result = lintRequirementCountRatchet({ changeFolder, baseRef });
      assert.equal(result.pass, false, JSON.stringify(result));
    } finally {
      cleanup(root);
    }
  });

  test('fail: a later readable commit does not erase an unreadable one before it', () => {
    const fixture = validThenUnreadable();
    const { root, changeFolder, baseRef } = fixture;
    try {
      writeInPlace(
        changeFolder,
        'decisions.md',
        decisionHeadings(['D1', 'D2', 'D3']) +
          baselineLedger([
            ['D1', 'initial', 0, 5],
            ['D2', 'scope-change', 5, 8],
            ['D3', 'scope-change', 8, 9],
          ]),
      );
      fixture.git(['add', '-A']);
      fixture.git(['commit', '--quiet', '-m', 'append D3, readable again']);

      const prior = resolvePriorBaselineRows({ changeFolder, baseRef });
      assert.equal(
        prior.status,
        'unavailable',
        'a readable snapshot after the gap cannot vouch for what the gap held: ' +
          JSON.stringify(prior),
      );
    } finally {
      cleanup(root);
    }
  });

  test('pass: an unreadable snapshot BEFORE any valid one is still tolerated work in progress', () => {
    // The narrow tolerance that must survive the fix. Nothing is asserted
    // immutable yet, so an early draft this lint cannot read costs nothing —
    // it is skipped exactly as an early WIP ledger is.
    const fixture = makeGitChange({
      'proposal.md': `# Proposal\n\n${requirementLedger(5)}`,
      'decisions.md': hidden(D1_ONLY),
    });
    const { root, changeFolder, baseRef } = fixture;
    try {
      writeInPlace(changeFolder, 'decisions.md', D1_ONLY);
      fixture.git(['add', '-A']);
      fixture.git(['commit', '--quiet', '-m', 'the ledger becomes readable']);

      const prior = resolvePriorBaselineRows({ changeFolder, baseRef });
      assert.equal(prior.status, 'found', JSON.stringify(prior));
      assert.deepEqual(prior.rows.map((r) => r.decisionId), ['D1']);
    } finally {
      cleanup(root);
    }
  });
});

describe('lintRequirementCountRatchet — every candidate path in a commit is reconciled', () => {
  // A commit record lists every path the commit touched, and the pathspecs
  // deliberately reach both the active and the archived location of the same
  // change. Stopping at the first path that happens to parse answers "what
  // does this commit say" with one arbitrary copy of it. The other copy can
  // hold rows this lint never sees, and rows it never sees are rows it cannot
  // hold immutable — the same bypass as an unreadable snapshot, reached
  // through path selection instead of through readability.
  function hidden(body) {
    return '# Decisions\n\n```markdown\n' + body + '```\n';
  }

  const D1_ONLY = decisionHeadings(['D1']) + baselineLedger([['D1', 'initial', 0, 5]]);
  const D1_D2 =
    decisionHeadings(['D1', 'D2']) +
    baselineLedger([['D1', 'initial', 0, 5], ['D2', 'scope-change', 5, 8]]);
  const D1_D3 =
    decisionHeadings(['D1', 'D3']) +
    baselineLedger([['D1', 'initial', 0, 5], ['D3', 'scope-change', 5, 9]]);

  const ARCHIVE_DIR = join('openspec', 'changes', 'archive', '2026-01-01-fixture-change');

  /** Add a second decisions.md at the archived path, inside the working tree. */
  function writeArchiveSibling(root, body) {
    const dir = join(root, ARCHIVE_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'decisions.md'), body, 'utf8');
  }

  /**
   * Commit A declares a readable ledger at the active path. Commit B appends a
   * row and lands TWO copies: the active one this lint can read, and an
   * archived sibling whose ledger it cannot. `git log --name-only` sorts the
   * archived path first, so the unreadable copy is seen and then discarded the
   * moment the active copy parses.
   */
  function readableBesideUnreadable() {
    const fixture = makeGitChange({
      'proposal.md': `# Proposal\n\n${requirementLedger(5)}`,
      'decisions.md': D1_ONLY,
    });
    // D2 is committed ONLY inside the copy this lint cannot read. The readable
    // copy still says D1, so an anchor taken from it alone never learns that
    // D2 exists — and a row it never learned about is a row it cannot hold
    // immutable. The readable copy is edited (prose only) so that the commit
    // record lists both paths, which is what makes this a path-selection case
    // rather than the wholly-unreadable one the previous block covers.
    writeInPlace(fixture.changeFolder, 'proposal.md', `# Proposal\n\n${requirementLedger(8)}`);
    writeInPlace(fixture.changeFolder, 'decisions.md', `${D1_ONLY}\nD2 is recorded in the archived copy.\n`);
    writeArchiveSibling(fixture.root, hidden(D1_D2));
    fixture.git(['add', '-A']);
    fixture.git(['commit', '--quiet', '-m', 'append D2 only in the unreadable archived copy']);
    return fixture;
  }

  test('fail: a readable path beside an unreadable one in the same commit is unavailable', () => {
    const { root, changeFolder, baseRef } = readableBesideUnreadable();
    try {
      const prior = resolvePriorBaselineRows({ changeFolder, baseRef });
      assert.equal(
        prior.status,
        'unavailable',
        'one parseable copy does not license ignoring a sibling this lint could not ' +
          `read: the sibling may hold rows this anchor then fails to protect: ${JSON.stringify(prior)}`,
      );
    } finally {
      cleanup(root);
    }
  });

  test('fail: the row hidden in the masked sibling cannot then be deleted', () => {
    const { root, changeFolder, baseRef } = readableBesideUnreadable();
    try {
      // The end-to-end consequence: D2 is committed. If the commit resolves to
      // the readable copy alone, nothing records that an unread sibling was
      // part of the same commit, and dropping back to D1 reads as an ordinary
      // extension rather than the deletion of a committed row.
      writeInPlace(changeFolder, 'proposal.md', `# Proposal\n\n${requirementLedger(5)}`);
      writeInPlace(changeFolder, 'decisions.md', D1_ONLY);

      const result = lintRequirementCountRatchet({ changeFolder, baseRef });
      assert.equal(
        result.pass,
        false,
        'D2 was committed; dropping it must not read as an ordinary state that ' +
          `simply never had it: ${JSON.stringify(result)}`,
      );
    } finally {
      cleanup(root);
    }
  });

  test('fail: two readable copies in one commit that disagree are unavailable', () => {
    const fixture = makeGitChange({
      'proposal.md': `# Proposal\n\n${requirementLedger(5)}`,
      'decisions.md': D1_ONLY,
    });
    try {
      writeInPlace(fixture.changeFolder, 'proposal.md', `# Proposal\n\n${requirementLedger(8)}`);
      writeInPlace(fixture.changeFolder, 'decisions.md', D1_D2);
      writeArchiveSibling(fixture.root, D1_D3);
      fixture.git(['add', '-A']);
      fixture.git(['commit', '--quiet', '-m', 'two readable ledgers that disagree']);

      const prior = resolvePriorBaselineRows({
        changeFolder: fixture.changeFolder,
        baseRef: fixture.baseRef,
      });
      assert.equal(
        prior.status,
        'unavailable',
        'taking whichever copy the path order happened to reach first picks one of ' +
          `two contradictory answers at random: ${JSON.stringify(prior)}`,
      );
    } finally {
      cleanup(fixture.root);
    }
  });

  test('pass: two readable copies in one commit that agree resolve to one snapshot', () => {
    // The tightening MUST NOT refuse the ordinary case it was built around:
    // the same ledger reachable at two paths is one answer, not a conflict.
    const fixture = makeGitChange({
      'proposal.md': `# Proposal\n\n${requirementLedger(5)}`,
      'decisions.md': D1_ONLY,
    });
    try {
      writeInPlace(fixture.changeFolder, 'proposal.md', `# Proposal\n\n${requirementLedger(8)}`);
      writeInPlace(fixture.changeFolder, 'decisions.md', D1_D2);
      writeArchiveSibling(fixture.root, D1_D2);
      fixture.git(['add', '-A']);
      fixture.git(['commit', '--quiet', '-m', 'the same ledger at two paths']);

      const prior = resolvePriorBaselineRows({
        changeFolder: fixture.changeFolder,
        baseRef: fixture.baseRef,
      });
      assert.equal(prior.status, 'found', JSON.stringify(prior));
      assert.deepEqual(
        prior.rows.map((row) => row.decisionId),
        ['D1', 'D2'],
      );
    } finally {
      cleanup(fixture.root);
    }
  });

  test('pass: a committed rename leaves the old path absent, not unreadable', () => {
    // The counterpart guard. A rename lists two paths in one record, but only
    // one of them is in that commit's tree. "Absent from this tree" MUST stay
    // a skip; only a path that IS in the tree and still cannot be read may
    // refuse the anchor. Conflating the two would fail closed on every archive.
    const fixture = makeGitChange({
      'proposal.md': `# Proposal\n\n${requirementLedger(5)}`,
      'decisions.md': D1_ONLY,
    });
    try {
      const archived = join(fixture.root, ARCHIVE_DIR);
      mkdirSync(dirname(archived), { recursive: true });
      renameSync(fixture.changeFolder, archived);
      fixture.git(['add', '-A']);
      fixture.git(['commit', '--quiet', '-m', 'archive the change']);

      const prior = resolvePriorBaselineRows({ changeFolder: archived, baseRef: fixture.baseRef });
      assert.equal(prior.status, 'found', JSON.stringify(prior));
      assert.deepEqual(
        prior.rows.map((row) => row.decisionId),
        ['D1'],
      );
    } finally {
      cleanup(fixture.root);
    }
  });
});

describe('lintRequirementCountRatchet — an unusable --base never falls back to count-only mode', () => {
  /** Baseline row raised in place: only the append-only check (which needs a base) sees it. */
  function mutatedBaselineFixture() {
    const fixture = makeGitChange({
      'proposal.md': `# Proposal\n\n${requirementLedger(5)}`,
      'decisions.md': decisionHeadings(['D1']) + baselineLedger([['D1', 'initial', 0, 5]]),
    });
    writeInPlace(fixture.changeFolder, 'proposal.md', `# Proposal\n\n${requirementLedger(6)}`);
    writeInPlace(
      fixture.changeFolder,
      'decisions.md',
      decisionHeadings(['D1']) + baselineLedger([['D1', 'initial', 0, 6]]),
    );
    return fixture;
  }

  test('fail closed: an empty or non-string base ref is an error, not "not requested"', () => {
    const { root, changeFolder } = mutatedBaselineFixture();
    try {
      for (const baseRef of ['', 0, false, {}]) {
        const result = lintRequirementCountRatchet({ changeFolder, baseRef });
        assert.equal(result.pass, false, `baseRef ${JSON.stringify(baseRef)} must not pass: ${JSON.stringify(result)}`);
        assert.match(result.error ?? '', /invalid change base ref/u);
      }
    } finally {
      cleanup(root);
    }
  });

  test('an omitted base (undefined or null) still means count-only mode', () => {
    const { root, changeFolder } = mutatedBaselineFixture();
    try {
      for (const baseRef of [undefined, null]) {
        const result = lintRequirementCountRatchet({ changeFolder, baseRef });
        assert.equal(result.pass, true, JSON.stringify(result));
        assert.equal(result.priorState, 'not-requested', JSON.stringify(result));
      }
    } finally {
      cleanup(root);
    }
  });

  test('CLI: --base with an empty value exits 1, an omitted --base keeps exiting 0', () => {
    const { root, changeFolder } = mutatedBaselineFixture();
    try {
      const empty = spawnSync('node', [SCRIPT, changeFolder, '--base', ''], { encoding: 'utf8' });
      assert.equal(empty.status, 1, empty.stdout + empty.stderr);
      assert.match(empty.stderr, /invalid change base ref/u);
      const omitted = spawnSync('node', [SCRIPT, changeFolder], { encoding: 'utf8' });
      assert.equal(omitted.status, 0, omitted.stdout + omitted.stderr);
    } finally {
      cleanup(root);
    }
  });
});
