import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { lintDeltaSpecCitations } from '../lint-delta-spec-citations.mjs';
import {
  scanThenAndCitations,
  headingExistsInTarget,
  headingMatchesRef,
  stripFencedCodeBlocks,
} from '../lib/spec-thenclause-citations.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '../lint-delta-spec-citations.mjs');
const CAP = 'demo-cap';
const CHANGE = 'demo-change';
const SPEC_REL = `openspec/changes/${CHANGE}/specs/${CAP}/spec.md`;

/** leaf `rule-a.md` carries `## Real Heading` and `## Gloss Heading (extra)`. */
function makeRepo({ withAgentRules = true, spec }) {
  const root = mkdtempSync(join(tmpdir(), 'lint-delta-spec-citations-'));
  if (withAgentRules) {
    mkdirSync(join(root, '.devpro/agent-rules'), { recursive: true });
    writeFileSync(
      join(root, '.devpro/agent-rules/rule-a.md'),
      '# Rule A\n\n## Real Heading\n\nbody\n\n## Gloss Heading (extra)\n\nbody\n',
    );
  }
  const changeFolder = join(root, 'openspec/changes', CHANGE);
  mkdirSync(join(changeFolder, 'specs', CAP), { recursive: true });
  writeFileSync(join(changeFolder, 'specs', CAP, 'spec.md'), spec);
  return { root, changeFolder };
}

/** Delta body with the given THEN line placed under the given H2 block. */
function deltaWith(thenLine, block = 'ADDED') {
  return [
    `## ${block} Requirements`,
    '',
    '### Requirement: Demo',
    '',
    'The demo SHALL work.',
    '',
    '#### Scenario: Demo Scenario',
    '',
    '- **WHEN** something happens',
    thenLine,
    '',
  ].join('\n');
}

function runCli(changeFolder, cwd) {
  return spawnSync('node', [SCRIPT, changeFolder], { cwd, encoding: 'utf8' });
}

function withRepo(opts, fn) {
  const repo = makeRepo(opts);
  try {
    return fn(repo);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
}

test('Scenario: Unresolvable Delta Citation Blocks — missing leaf is reported as unresolved leaf', () => {
  withRepo({ spec: deltaWith('- **THEN** it follows `no-such-leaf.md` §Real Heading') }, ({ root, changeFolder }) => {
    const result = lintDeltaSpecCitations({ changeFolder, repoRoot: root });
    assert.equal(result.pass, false);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].reason, 'unresolved leaf');
    assert.equal(result.violations[0].line, 10);
    const cli = runCli(changeFolder, root);
    assert.equal(cli.status, 1);
    assert.ok(
      cli.stderr.includes(`[lint-delta-spec-citations] ${CAP} :: ${SPEC_REL}:10 :: unresolved leaf`),
      cli.stderr,
    );
  });
});

test('Scenario: Unresolvable Delta Citation Blocks — leaf exists but heading missing reports heading not found', () => {
  withRepo({ spec: deltaWith('- **THEN** it follows `rule-a.md` §No Such Heading') }, ({ root, changeFolder }) => {
    const result = lintDeltaSpecCitations({ changeFolder, repoRoot: root });
    assert.equal(result.pass, false);
    assert.deepEqual(result.violations.map((v) => v.reason), ['heading not found']);
    const cli = runCli(changeFolder, root);
    assert.equal(cli.status, 1);
    assert.ok(cli.stderr.includes(`${CAP} :: ${SPEC_REL}:10 :: heading not found`), cli.stderr);
  });
});

test('Scenario: Citation Followed By Trailing Text Blocks — full-width comma then text is not clause-final', () => {
  withRepo({ spec: deltaWith('- **THEN** it follows `rule-a.md` §Real Heading，and more words') }, ({ root, changeFolder }) => {
    const result = lintDeltaSpecCitations({ changeFolder, repoRoot: root });
    assert.equal(result.pass, false);
    assert.deepEqual(result.violations.map((v) => v.reason), ['citation not clause-final']);
    const cli = runCli(changeFolder, root);
    assert.equal(cli.status, 1);
    assert.ok(cli.stderr.includes(`${CAP} :: ${SPEC_REL}:10 :: citation not clause-final`), cli.stderr);
  });
});

test('Scenario: Citation Followed By Trailing Text Blocks — ASCII comma then text is heading not found', () => {
  withRepo({ spec: deltaWith('- **THEN** it follows `rule-a.md` §Real Heading, and more words') }, ({ root, changeFolder }) => {
    const result = lintDeltaSpecCitations({ changeFolder, repoRoot: root });
    assert.equal(result.pass, false);
    assert.deepEqual(result.violations.map((v) => v.reason), ['heading not found']);
    const cli = runCli(changeFolder, root);
    assert.equal(cli.status, 1);
    assert.ok(cli.stderr.includes(':: heading not found'), cli.stderr);
    assert.ok(!cli.stderr.includes('citation not clause-final'), cli.stderr);
  });
});

test('Scenario: Citation Followed By Trailing Text Blocks — a missing heading plus trailing text reports both reasons', () => {
  withRepo({ spec: deltaWith('- **THEN** it follows `rule-a.md` §Nope，then more') }, ({ root, changeFolder }) => {
    const result = lintDeltaSpecCitations({ changeFolder, repoRoot: root });
    assert.deepEqual(
      result.violations.map((v) => v.reason).sort(),
      ['citation not clause-final', 'heading not found'],
    );
  });
});

test('Scenario: Removed And Fenced Citations Are Not Scanned — REMOVED block is ignored', () => {
  const spec = deltaWith('- **THEN** it follows `no-such-leaf.md` §Nope', 'REMOVED');
  withRepo({ spec }, ({ root, changeFolder }) => {
    const result = lintDeltaSpecCitations({ changeFolder, repoRoot: root });
    assert.equal(result.pass, true, JSON.stringify(result.violations));
    assert.equal(runCli(changeFolder, root).status, 0);
  });
});

test('Scenario: Removed And Fenced Citations Are Not Scanned — fenced block inside ADDED is ignored', () => {
  const spec = [
    '## ADDED Requirements',
    '',
    '### Requirement: Demo',
    '',
    '```markdown',
    '- **THEN** it follows `no-such-leaf.md` §Nope',
    '```',
    '',
    '#### Scenario: Demo Scenario',
    '',
    '- **WHEN** something happens',
    '- **THEN** it is fine',
    '',
  ].join('\n');
  withRepo({ spec }, ({ root, changeFolder }) => {
    const result = lintDeltaSpecCitations({ changeFolder, repoRoot: root });
    assert.equal(result.pass, true, JSON.stringify(result.violations));
    assert.equal(runCli(changeFolder, root).status, 0);
  });
});

test('Scenario: Removed And Fenced Citations Are Not Scanned — tilde fenced block inside ADDED is ignored', () => {
  const spec = [
    '## ADDED Requirements',
    '',
    '### Requirement: Demo',
    '',
    '~~~markdown',
    '- **THEN** it follows `no-such-leaf.md` §Nope',
    '~~~',
    '',
    '#### Scenario: Demo Scenario',
    '',
    '- **WHEN** something happens',
    '- **THEN** it is fine',
    '',
  ].join('\n');
  withRepo({ spec }, ({ root, changeFolder }) => {
    const result = lintDeltaSpecCitations({ changeFolder, repoRoot: root });
    assert.equal(result.pass, true, JSON.stringify(result.violations));
    assert.equal(runCli(changeFolder, root).status, 0);
  });
});

test('Scenario: Removed And Fenced Citations Are Not Scanned — H2 line inside a tilde fence does not end the scanned block', () => {
  const spec = [
    '## ADDED Requirements',
    '',
    '### Requirement: Demo',
    '',
    '~~~markdown',
    '## Example',
    '~~~',
    '',
    '#### Scenario: Demo Scenario',
    '',
    '- **WHEN** something happens',
    '- **THEN** it follows `no-such-leaf.md` §Nope',
    '',
  ].join('\n');
  withRepo({ spec }, ({ root, changeFolder }) => {
    const result = lintDeltaSpecCitations({ changeFolder, repoRoot: root });
    assert.equal(result.pass, false);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].line, 12);
    assert.equal(result.violations[0].reason, 'unresolved leaf');
    assert.equal(runCli(changeFolder, root).status, 1);
  });
});

test('Scenario: Removed And Fenced Citations Are Not Scanned — a tilde line inside a backtick fence does not close it', () => {
  const content = ['```', '~~~', '- **THEN** x `no-such-leaf.md` §Nope', '```', '- **THEN** y'].join('\n');
  const out = stripFencedCodeBlocks(content);
  assert.equal(out.split('\n').length, 5);
  assert.equal(out.split('\n').slice(0, 4).every((line) => line === ''), true);
  assert.equal(out.split('\n')[4], '- **THEN** y');
});

test('Scenario: Removed And Fenced Citations Are Not Scanned — a line starting with an inline backtick span is not a fence opener', () => {
  const spec = [
    '## ADDED Requirements',
    '',
    '### Requirement: Demo',
    '',
    '```x``` inline span at the start of a line',
    '',
    '#### Scenario: Demo Scenario',
    '',
    '- **WHEN** something happens',
    '- **THEN** it follows `no-such-leaf.md` §Nope',
    '',
  ].join('\n');
  withRepo({ spec }, ({ root, changeFolder }) => {
    const result = lintDeltaSpecCitations({ changeFolder, repoRoot: root });
    assert.equal(result.pass, false);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].line, 10);
    assert.equal(runCli(changeFolder, root).status, 1);
  });
});

test('Scenario: Removed And Fenced Citations Are Not Scanned — an info-string fence line inside a fence does not close it', () => {
  const content = ['```', '```js', '- **THEN** x `no-such-leaf.md` §Nope', '```', '- **THEN** y'].join('\n');
  const out = stripFencedCodeBlocks(content).split('\n');
  assert.equal(out.length, 5);
  assert.deepEqual(out.slice(0, 4), ['', '', '', '']);
  assert.equal(out[4], '- **THEN** y');
  const longer = ['````', '```', '- **THEN** z', '````', '- **THEN** y'].join('\n');
  assert.deepEqual(stripFencedCodeBlocks(longer).split('\n'), ['', '', '', '', '- **THEN** y']);
  assert.deepEqual(stripFencedCodeBlocks('```\r\nx\r\n```\r\ny').split('\n'), ['', '', '', 'y']);
});

test('Scenario: Removed And Fenced Citations Are Not Scanned — MODIFIED block is scanned with the original line number', () => {
  const spec = [
    '## REMOVED Requirements',
    '',
    '### Requirement: Gone',
    '',
    '```',
    'fenced',
    'lines',
    '```',
    '',
    '## MODIFIED Requirements',
    '',
    '### Requirement: Demo',
    '',
    '#### Scenario: Demo Scenario',
    '',
    '- **WHEN** something happens',
    '- **THEN** it follows `no-such-leaf.md` §Nope',
    '',
  ].join('\n');
  withRepo({ spec }, ({ root, changeFolder }) => {
    const result = lintDeltaSpecCitations({ changeFolder, repoRoot: root });
    assert.equal(result.pass, false);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].line, 17);
    assert.ok(runCli(changeFolder, root).stderr.includes(`${SPEC_REL}:17 :: unresolved leaf`));
  });
});

test('Scenario: Removed And Fenced Citations Are Not Scanned — CRLF files keep original line numbers', () => {
  const spec = deltaWith('- **THEN** it follows `no-such-leaf.md` §Nope').replace(/\n/g, '\r\n');
  withRepo({ spec }, ({ root, changeFolder }) => {
    const result = lintDeltaSpecCitations({ changeFolder, repoRoot: root });
    assert.equal(result.pass, false);
    assert.equal(result.violations[0].line, 10);
  });
});

test('Scenario: Resolvable Delta Citation Passes — plain, per-prefixed and parenthetical-gloss citations', () => {
  const spec = [
    '## ADDED Requirements',
    '',
    '### Requirement: Demo',
    '',
    '#### Scenario: Demo Scenario',
    '',
    '- **WHEN** something happens',
    '- **THEN** it follows `rule-a.md` §Real Heading',
    '- **AND** per `rule-a.md` §Real Heading。',
    '- **AND** it follows `rule-a.md` §Gloss Heading',
    '',
  ].join('\n');
  withRepo({ spec }, ({ root, changeFolder }) => {
    const result = lintDeltaSpecCitations({ changeFolder, repoRoot: root });
    assert.equal(result.pass, true, JSON.stringify(result.violations));
    const cli = runCli(changeFolder, root);
    assert.equal(cli.status, 0, cli.stderr);
    assert.ok(cli.stdout.includes(`[lint-delta-spec-citations] ${changeFolder}: pass`), cli.stdout);
  });
});

test('Scenario: Resolvable Delta Citation Passes — absent agent-rules directory is a printed no-op', () => {
  const spec = deltaWith('- **THEN** it follows `no-such-leaf.md` §Nope');
  withRepo({ spec, withAgentRules: false }, ({ root, changeFolder }) => {
    const result = lintDeltaSpecCitations({ changeFolder, repoRoot: root });
    assert.equal(result.pass, true);
    assert.match(String(result.noop), /not found; citations not checkable/);
    const cli = runCli(changeFolder, root);
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /not found; citations not checkable/);
  });
});

test('lint-delta-spec-citations accepts an active change whose name merely starts with archive', () => {
  const spec = deltaWith('- **THEN** it follows `no-such-leaf.md` §Nope');
  withRepo({ spec }, ({ root }) => {
    const folder = join(root, 'openspec/changes/archive-tooling-cleanup');
    mkdirSync(join(folder, 'specs', CAP), { recursive: true });
    writeFileSync(join(folder, 'specs', CAP, 'spec.md'), spec);
    const result = lintDeltaSpecCitations({ changeFolder: folder, repoRoot: root });
    assert.equal(result.error, undefined);
    assert.equal(result.pass, false);
    assert.equal(result.violations.length, 1);
    const cli = runCli(folder, root);
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /unresolved leaf/);
    assert.doesNotMatch(cli.stderr, /ACTIVE openspec\/changes/);
  });
});

test('lint-delta-spec-citations refuses archive paths and missing folders', () => {
  withRepo({ spec: deltaWith('- **THEN** fine') }, ({ root }) => {
    const archived = join(root, 'openspec/changes/archive/2026-01-01-demo');
    mkdirSync(join(archived, 'specs', CAP), { recursive: true });
    const result = lintDeltaSpecCitations({ changeFolder: archived, repoRoot: root });
    assert.equal(result.pass, false);
    assert.match(String(result.error), /ACTIVE/);
    assert.equal(runCli(archived, root).status, 1);

    const missing = join(root, 'openspec/changes/nope');
    assert.match(String(lintDeltaSpecCitations({ changeFolder: missing, repoRoot: root }).error), /not found/);
    const cli = runCli(missing, root);
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /change folder not found/);
  });
});

test('lint-delta-spec-citations CLI without argument prints usage and exits 1', () => {
  const r = spawnSync('node', [SCRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage/);
});

test('lint-delta-spec-citations defaults repoRoot to changeFolder/../../..', () => {
  withRepo({ spec: deltaWith('- **THEN** it follows `no-such-leaf.md` §Nope') }, ({ changeFolder }) => {
    const result = lintDeltaSpecCitations({ changeFolder });
    assert.equal(result.pass, false);
    assert.equal(result.violations[0].reason, 'unresolved leaf');
  });
});

test('shared scan: scanThenAndCitations / headingExistsInTarget behave as the canonical test expects', () => {
  withRepo({ spec: '' }, ({ root }) => {
    const agentRulesDir = join(root, '.devpro/agent-rules');
    const content = [
      '- **THEN** ok `rule-a.md` §Real Heading',
      '- **THEN** bad `ghost.md` §X',
      '- **AND** trail `rule-a.md` §Real Heading，tail',
      'prose line `rule-a.md` §Real Heading',
    ].join('\n');
    const scan = scanThenAndCitations({ content, agentRulesDir });
    assert.deepEqual(scan.unresolved, [{ lineNo: 2, filename: 'ghost.md' }]);
    assert.equal(scan.citations.length, 2);
    assert.deepEqual(scan.citations.map((c) => c.lineNo), [1, 3]);
    assert.equal(scan.nonClauseFinal.length, 1);
    assert.equal(scan.nonClauseFinal[0].lineNo, 3);
    assert.equal(headingExistsInTarget(scan.citations[0].targetPath, 'Real Heading'), true);
    assert.equal(headingExistsInTarget(scan.citations[0].targetPath, 'Nope'), false);
    assert.equal(headingMatchesRef('## 6 Principles', 'NoSuchHeading'), false);
    assert.equal(stripFencedCodeBlocks('a\n```\nb\nc\n```\nd').split('\n').length, 6);
  });
});

test('Scenario: Canonical Scan Shares The Judgment — canonical test imports the lib and carries no second copy', () => {
  const src = readFileSync(join(HERE, 'cross-ref-spec-thenclause-grep.test.mjs'), 'utf8');
  assert.match(src, /from\s+['"]\.\.\/lib\/spec-thenclause-citations\.mjs['"]/);
  assert.doesNotMatch(src, /function\s+headingMatchesRef\b/);
  assert.doesNotMatch(src, /(?:const|let|var)\s+LEAF_SECTION_RE\b/);
  assert.doesNotMatch(src, /function\s+stripFencedCodeBlocks\b/);
  assert.doesNotMatch(src, /(?:const|let|var)\s+CITATION_TRAILING_RE\b/);
  const lintSrc = readFileSync(SCRIPT, 'utf8');
  assert.match(lintSrc, /lib\/spec-thenclause-citations\.mjs/);
  assert.doesNotMatch(lintSrc, /(?:const|let|var)\s+LEAF_SECTION_RE\b/);
});
