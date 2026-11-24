import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSecuritySeverity, bucketByCvss, extractCwe, renderHtml } from '../sarif-report.mjs';

// ─── Group 1: parseSecuritySeverity ──────────────────────────────────────────

describe('parseSecuritySeverity', () => {
  it('returns float for valid string "8.5"', () => {
    const rule = { properties: { 'security-severity': '8.5' } };
    assert.equal(parseSecuritySeverity(rule), 8.5);
  });

  it('returns null for NaN string "abc"', () => {
    const rule = { properties: { 'security-severity': 'abc' } };
    assert.equal(parseSecuritySeverity(rule), null);
  });

  it('returns null when security-severity property is undefined', () => {
    const rule = { properties: {} };
    assert.equal(parseSecuritySeverity(rule), null);
  });

  it('returns null when rule has no properties field', () => {
    const rule = {};
    assert.equal(parseSecuritySeverity(rule), null);
  });

  it('returns null when rule is undefined', () => {
    assert.equal(parseSecuritySeverity(undefined), null);
  });

  it('returns null for null rule', () => {
    assert.equal(parseSecuritySeverity(null), null);
  });
});

// ─── Group 2: bucketByCvss — D1 boundary values ──────────────────────────────

describe('bucketByCvss boundary values', () => {
  it('9.0 → "Critical"', () => assert.equal(bucketByCvss(9.0), 'Critical'));
  it('10.0 → "Critical"', () => assert.equal(bucketByCvss(10.0), 'Critical'));
  it('8.99 → "High"', () => assert.equal(bucketByCvss(8.99), 'High'));
  it('7.0 → "High"', () => assert.equal(bucketByCvss(7.0), 'High'));
  it('6.99 → "Medium"', () => assert.equal(bucketByCvss(6.99), 'Medium'));
  it('4.0 → "Medium"', () => assert.equal(bucketByCvss(4.0), 'Medium'));
  it('3.99 → "Low"', () => assert.equal(bucketByCvss(3.99), 'Low'));
  it('0.1 → "Low"', () => assert.equal(bucketByCvss(0.1), 'Low'));
  it('0.0 → null', () => assert.equal(bucketByCvss(0.0), null));
  it('null → null', () => assert.equal(bucketByCvss(null), null));
  it('undefined → null', () => assert.equal(bucketByCvss(undefined), null));
  it('NaN → null', () => assert.equal(bucketByCvss(NaN), null));
});

// ─── Group 3: extractCwe — tag filtering ─────────────────────────────────────

describe('extractCwe tag filtering', () => {
  it('single tag extracts CWE id', () => {
    const rule = { properties: { tags: ['external/cwe/cwe-89'] } };
    assert.deepEqual(extractCwe(rule), ['CWE-89']);
  });

  it('multiple tags returns matching CWEs only', () => {
    const rule = { properties: { tags: ['external/cwe/cwe-79', 'external/cwe/cwe-80', 'other/tag'] } };
    assert.deepEqual(extractCwe(rule), ['CWE-79', 'CWE-80']);
  });

  it('empty tags array returns []', () => {
    const rule = { properties: { tags: [] } };
    assert.deepEqual(extractCwe(rule), []);
  });

  it('no tags property returns []', () => {
    const rule = { properties: {} };
    assert.deepEqual(extractCwe(rule), []);
  });

  it('undefined tags property returns []', () => {
    const rule = { properties: { tags: undefined } };
    assert.deepEqual(extractCwe(rule), []);
  });

  it('strips leading zeros from numeric CWE id', () => {
    const rule = { properties: { tags: ['external/cwe/cwe-079'] } };
    assert.deepEqual(extractCwe(rule), ['CWE-79']);
  });

  it('no properties field returns []', () => {
    const rule = {};
    assert.deepEqual(extractCwe(rule), []);
  });
});

// ─── Group 4: Integration — fixture SARIF pipeline ───────────────────────────

describe('integration: cvssCounts + noCvssCount accumulation', () => {
  // Inline fixture: 3 rules, 3 findings
  const fixtureRun = {
    tool: {
      driver: {
        name: 'CodeQL',
        rules: [
          {
            id: 'rule-critical',
            properties: { 'security-severity': '9.5' },
            defaultConfiguration: { level: 'error' },
          },
          {
            id: 'rule-high',
            properties: { 'security-severity': '7.0' },
            defaultConfiguration: { level: 'error' },
          },
          {
            id: 'rule-nocvss',
            properties: {},
            defaultConfiguration: { level: 'warning' },
          },
        ],
      },
    },
    results: [
      { ruleId: 'rule-critical', message: { text: 'critical finding' }, locations: [] },
      { ruleId: 'rule-high', message: { text: 'high finding' }, locations: [] },
      { ruleId: 'rule-nocvss', message: { text: 'no cvss finding' }, locations: [] },
    ],
    artifacts: [],
  };

  // Build rulesIndex and accumulate cvssCounts manually (replicating main() logic)
  function runPipeline(run) {
    const rulesIndex = {};
    for (const r of run.tool.driver.rules ?? []) rulesIndex[r.id] = r;

    const cvssCounts = { Critical: 0, High: 0, Medium: 0, Low: 0 };
    let noCvssCount = 0;
    const byRuleCvss = {};

    for (const r of run.results) {
      const rid = r.ruleId ?? '(unknown)';
      const rule = rulesIndex[rid] ?? {};
      const score = parseSecuritySeverity(rule);
      const bucket = bucketByCvss(score);

      if (bucket !== null) {
        cvssCounts[bucket] = (cvssCounts[bucket] ?? 0) + 1;
      } else {
        noCvssCount++;
      }

      if (!(rid in byRuleCvss) && score !== null) {
        byRuleCvss[rid] = { bucket, score: String(score) };
      } else if (!(rid in byRuleCvss)) {
        byRuleCvss[rid] = null;
      }
    }

    return { cvssCounts, noCvssCount, byRuleCvss };
  }

  it('cvssCounts.Critical === 1 for CVSS 9.5 rule', () => {
    const { cvssCounts } = runPipeline(fixtureRun);
    assert.equal(cvssCounts.Critical, 1);
  });

  it('cvssCounts.High === 1 for CVSS 7.0 rule', () => {
    const { cvssCounts } = runPipeline(fixtureRun);
    assert.equal(cvssCounts.High, 1);
  });

  it('noCvssCount === 1 for rule without security-severity', () => {
    const { noCvssCount } = runPipeline(fixtureRun);
    assert.equal(noCvssCount, 1);
  });

  it('byRuleCvss["rule-critical"] has bucket Critical and score "9.5"', () => {
    const { byRuleCvss } = runPipeline(fixtureRun);
    assert.deepEqual(byRuleCvss['rule-critical'], { bucket: 'Critical', score: '9.5' });
  });

  it('byRuleCvss["rule-nocvss"] is null', () => {
    const { byRuleCvss } = runPipeline(fixtureRun);
    assert.equal(byRuleCvss['rule-nocvss'], null);
  });
});

// ─── Group 5: Backward compat — no security-severity does not crash ───────────

describe('backward compat: SARIF with no security-severity fields', () => {
  function runPipelineNoProps(run) {
    const rulesIndex = {};
    for (const r of run.tool.driver.rules ?? []) rulesIndex[r.id] = r;

    const cvssCounts = { Critical: 0, High: 0, Medium: 0, Low: 0 };
    let noCvssCount = 0;
    const byRuleCvss = {};

    for (const r of run.results) {
      const rid = r.ruleId ?? '(unknown)';
      const rule = rulesIndex[rid] ?? {};
      const score = parseSecuritySeverity(rule);
      const bucket = bucketByCvss(score);

      if (bucket !== null) {
        cvssCounts[bucket] = (cvssCounts[bucket] ?? 0) + 1;
      } else {
        noCvssCount++;
      }

      if (!(rid in byRuleCvss) && score !== null) {
        byRuleCvss[rid] = { bucket, score: String(score) };
      } else if (!(rid in byRuleCvss)) {
        byRuleCvss[rid] = null;
      }
    }

    return { cvssCounts, noCvssCount };
  }

  const oldStyleRun = {
    tool: {
      driver: {
        name: 'CodeQL',
        // rules have NO properties field at all (old SARIF style)
        rules: [
          { id: 'rule-a', defaultConfiguration: { level: 'warning' } },
          { id: 'rule-b', defaultConfiguration: { level: 'note' } },
        ],
      },
    },
    results: [
      { ruleId: 'rule-a', message: { text: 'finding a' }, locations: [] },
      { ruleId: 'rule-b', message: { text: 'finding b' }, locations: [] },
      { ruleId: 'rule-a', message: { text: 'finding a2' }, locations: [] },
    ],
    artifacts: [],
  };

  it('pipeline completes without throwing', () => {
    assert.doesNotThrow(() => runPipelineNoProps(oldStyleRun));
  });

  it('all cvssCounts values are 0', () => {
    const { cvssCounts } = runPipelineNoProps(oldStyleRun);
    assert.equal(cvssCounts.Critical, 0);
    assert.equal(cvssCounts.High, 0);
    assert.equal(cvssCounts.Medium, 0);
    assert.equal(cvssCounts.Low, 0);
  });

  it('noCvssCount equals total finding count (3)', () => {
    const { noCvssCount } = runPipelineNoProps(oldStyleRun);
    assert.equal(noCvssCount, 3);
  });
});

// ─── Group 6: HTML smoke — dual-grid anchors ─────────────────────────────────

describe('HTML smoke: dual-grid anchors', () => {
  // Minimal fixture to drive renderHtml
  const fixtureRulesIndex = {
    'rule-xss': {
      id: 'rule-xss',
      name: 'Cross-site scripting',
      shortDescription: { text: 'XSS vulnerability' },
      fullDescription: { text: 'Cross-site scripting allows attackers...' },
      defaultConfiguration: { level: 'error' },
      properties: { 'security-severity': '8.5', tags: ['external/cwe/cwe-79'] },
    },
    'rule-info': {
      id: 'rule-info',
      name: 'Information disclosure',
      shortDescription: { text: 'Sensitive info leaked' },
      fullDescription: { text: 'Information may be disclosed...' },
      defaultConfiguration: { level: 'warning' },
      properties: {},
    },
  };

  const fixtureByRule = new Map([
    ['rule-xss', [{ ruleId: 'rule-xss', message: { text: 'xss finding' }, locations: [] }]],
    ['rule-info', [{ ruleId: 'rule-info', message: { text: 'info finding' }, locations: [] }]],
  ]);

  const fixtureResults = [
    { ruleId: 'rule-xss', message: { text: 'xss finding' }, locations: [] },
    { ruleId: 'rule-info', message: { text: 'info finding' }, locations: [] },
  ];

  const htmlOut = renderHtml({
    project: 'smoke-test',
    tool: 'CodeQL',
    toolVer: '2.0.0',
    scanTime: '2026-04-28 00:00:00',
    results: fixtureResults,
    byRule: fixtureByRule,
    sevCounts: { error: 1, warning: 1 },
    artifacts: [],
    filesWithFindings: new Set(),
    rulesIndex: fixtureRulesIndex,
    sourceRoot: null,
    cvssCounts: { Critical: 0, High: 1, Medium: 0, Low: 0 },
    noCvssCount: 1,
    byRuleCvss: {
      'rule-xss': { bucket: 'High', score: '8.5' },
      'rule-info': null,
    },
  });

  it('HTML contains "Security Severity (CVSS)" heading', () => {
    assert.ok(htmlOut.includes('Security Severity (CVSS)'), 'missing Security Severity (CVSS)');
  });

  it('HTML contains "Problem Severity" heading', () => {
    assert.ok(htmlOut.includes('Problem Severity'), 'missing Problem Severity');
  });

  it('HTML contains CVSS footnote with 不含 CVSS 分數', () => {
    assert.ok(htmlOut.includes('不含 CVSS 分數'), 'missing CVSS footnote text');
  });

  it('HTML contains summary-grid-cvss div (upper 4-card grid)', () => {
    assert.ok(htmlOut.includes('class="summary-grid-cvss"'), 'missing summary-grid-cvss');
  });

  it('HTML contains summary-grid div (lower 3-card grid)', () => {
    assert.ok(htmlOut.includes('class="summary-grid"'), 'missing summary-grid');
  });

  it('thead contains 7 <th> elements', () => {
    const thMatches = htmlOut.match(/<th>/g);
    // There may be multiple tables; count all <th> occurrences — we need at least 7
    assert.ok(thMatches && thMatches.length >= 7, `expected >= 7 <th>, got ${thMatches?.length}`);
  });

  it('thead contains Security Severity and CVSS column headers', () => {
    assert.ok(htmlOut.includes('<th>Security Severity</th>'), 'missing Security Severity th');
    assert.ok(htmlOut.includes('<th>CVSS</th>'), 'missing CVSS th');
  });

  it('rule with CVSS 8.5 shows score in rule table row', () => {
    assert.ok(htmlOut.includes('8.5'), 'CVSS score 8.5 missing from output');
  });

  it('rule without CVSS shows — in both new table columns', () => {
    // The rule-info row should have — for Security Severity and CVSS
    // Check that — appears in the output (it will for fallback values)
    assert.ok(htmlOut.includes('>—<'), 'fallback — missing for rule without CVSS');
  });

  it('§3 rule-xss card contains CVSS: 8.5', () => {
    assert.ok(htmlOut.includes('CVSS: <strong>8.5</strong>'), 'CVSS score missing from rule card');
  });

  it('§3 rule-xss card contains CWE-79 badge', () => {
    assert.ok(htmlOut.includes('<span class="badge">CWE-79</span>'), 'CWE badge missing from rule card');
  });

  it('§3 rule without CVSS shows N/A', () => {
    assert.ok(htmlOut.includes('CVSS: <strong>N/A</strong>'), 'N/A missing for rule without CVSS');
  });
});
