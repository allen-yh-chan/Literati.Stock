/**
 * Validate load-bearing rule-file references in current canonical OpenSpec specs.
 *
 * Scope is intentionally narrow:
 *   - openspec/specs/<capability>/spec.md only (never active/frozen changes)
 *   - backticked, fully-qualified .devpro/agent-rules/*.md literals
 *   - backticked rule filenames following the exact bootstrap marker
 *
 * This is not a repository-wide Markdown link checker.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, repoPath } from './lib/repo-root.mjs';

const canonicalSpecsDir = repoPath('openspec/specs');

const BOOTSTRAP_MARKER = 'Bootstrap-only paths are confined to ';
const FULLY_QUALIFIED_RULE_RE = /`(\.devpro\/agent-rules\/[a-z0-9][a-z0-9._/-]*\.md)`/g;
const BOOTSTRAP_RULE_RE = /`((?:\.devpro\/agent-rules\/)?[a-z][a-z0-9-]*\.md)`/g;

const INTENTIONAL_ORPHAN = Object.freeze({
  source: 'openspec/specs/subagent-behavioral-contract/spec.md',
  reference: '.devpro/agent-rules/foo.md',
});
const FORBIDDEN_EXAMPLE = Object.freeze({
  source: 'openspec/specs/hook-payload-policy/spec.md',
  reference: 'sync-devpro-agent-rules.md',
});

function repoRelative(absolutePath) {
  return path.relative(REPO_ROOT, absolutePath).split(path.sep).join('/');
}

function collectCanonicalSpecFiles() {
  if (!existsSync(canonicalSpecsDir)) return [];

  return readdirSync(canonicalSpecsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(canonicalSpecsDir, entry.name, 'spec.md'))
    .filter((candidate) => existsSync(candidate) && statSync(candidate).isFile())
    .sort();
}

/** Remove fenced content while retaining the original newline count. */
function stripFencedCodeBlocks(content) {
  const lines = content.split(/\r?\n/);
  let fence = null;

  return lines.map((line) => {
    const opening = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (!fence && opening) {
      fence = {
        char: opening[1][0],
        length: opening[1].length,
      };
      return '';
    }
    if (fence) {
      const closing = new RegExp(`^ {0,3}${fence.char}{${fence.length},}[ \\t]*$`);
      if (closing.test(line)) fence = null;
      return '';
    }
    return line;
  }).join('\n');
}

test('fenced-code stripping honors opener length, delimiter, indentation, and line count', () => {
  for (const delimiter of ['`', '~']) {
    const opener = delimiter.repeat(4);
    const oppositeDelimiter = delimiter === '`' ? '~~~~' : '````';
    const shorterInterior = delimiter.repeat(3);
    const source = [
      'before',
      `${opener}markdown`,
      '`.devpro/agent-rules/inside-before.md`',
      oppositeDelimiter,
      '`.devpro/agent-rules/inside-after-opposite-delimiter.md`',
      oppositeDelimiter,
      shorterInterior,
      '`.devpro/agent-rules/inside-after-shorter-line.md`',
      `    ${opener}`,
      '`.devpro/agent-rules/inside-after-overindented-close.md`',
      opener,
      'after `.devpro/agent-rules/rules-flow.md`',
    ].join('\n');

    assert.deepEqual(
      stripFencedCodeBlocks(source).split('\n'),
      [
        'before',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        'after `.devpro/agent-rules/rules-flow.md`',
      ],
      `${opener} fence must close only with the same delimiter, sufficient length, and at most 3 spaces`,
    );
  }
});

test('fenced-code stripping recognizes CRLF closing boundaries', () => {
  const source = [
    'before',
    '```markdown',
    '`.devpro/agent-rules/inside.md`',
    '```',
    'after `.devpro/agent-rules/rules-flow.md`',
  ].join('\r\n');

  assert.deepEqual(
    stripFencedCodeBlocks(source).split('\n'),
    [
      'before',
      '',
      '',
      '',
      'after `.devpro/agent-rules/rules-flow.md`',
    ],
  );
});

test('bootstrap extraction uses only the exact marker boundary', () => {
  const source = 'synthetic/bootstrap-boundary/spec.md';
  const { bootstrapMarkerMatches, candidates } = extractCandidatesFromSources([{
    source,
    content: [
      '`before-marker.md` Bootstrap-only paths are confined to `after-marker.md`',
      'Bootstrap paths are confined to `lookalike-marker.md`',
    ].join('\n'),
  }]);

  assert.equal(bootstrapMarkerMatches, 1);
  assert.deepEqual(candidates, [{
    source,
    lineNo: 1,
    line: '`before-marker.md` Bootstrap-only paths are confined to `after-marker.md`',
    reference: 'after-marker.md',
  }]);
});

test('synthetic unresolved references retain complete aggregated diagnostics', () => {
  const source = 'synthetic/two-unresolved/spec.md';
  const { candidates } = extractCandidatesFromSources([{
    source,
    content: [
      'Rule: `.devpro/agent-rules/missing-one.md`.',
      'Bootstrap-only paths are confined to `missing-two.md`.',
    ].join('\n'),
  }]);
  const unresolvedCandidates = findUnresolvedCandidates(candidates, {
    isExempt: () => false,
    targetExists: () => false,
  });

  assert.equal(unresolvedCandidates.length, 2);
  assert.equal(
    formatUnresolvedDiagnostics(unresolvedCandidates),
    [
      [
        `source=${source}:1`,
        'reference=.devpro/agent-rules/missing-one.md',
        'expected=.devpro/agent-rules/missing-one.md',
        'classification=unresolved_canonical_rule_reference',
      ].join('\n'),
      [
        `source=${source}:2`,
        'reference=missing-two.md',
        'expected=.devpro/agent-rules/missing-two.md',
        'classification=unresolved_canonical_rule_reference',
      ].join('\n'),
    ].join('\n---\n'),
  );
});

function isLiteralRuleReference(reference) {
  if (reference.includes('..') || reference.includes('//')) return false;
  return !/[<>{}*?\[\]]/.test(reference);
}

function expectedTarget(reference) {
  return reference.startsWith('.devpro/agent-rules/')
    ? reference
    : `.devpro/agent-rules/${reference}`;
}

function targetIsFile(target) {
  const absoluteTarget = repoPath(target);
  const rulesRoot = repoPath('.devpro/agent-rules');
  if (!absoluteTarget.startsWith(`${rulesRoot}${path.sep}`)) return false;

  try {
    return statSync(absoluteTarget).isFile();
  } catch {
    return false;
  }
}

function isIntentionalOrphan(candidate) {
  return candidate.source === INTENTIONAL_ORPHAN.source
    && candidate.reference === INTENTIONAL_ORPHAN.reference
    && candidate.line.includes('e.g.')
    && candidate.line.includes('orphan leaf');
}

function extractCandidatesFromSources(sources) {
  const deduplicated = new Map();
  let bootstrapMarkerMatches = 0;

  for (const { source, content: rawContent } of sources) {
    const content = stripFencedCodeBlocks(rawContent);
    const lines = content.split('\n');

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const lineNo = index + 1;

      for (const match of line.matchAll(FULLY_QUALIFIED_RULE_RE)) {
        const reference = match[1];
        if (!isLiteralRuleReference(reference)) continue;
        deduplicated.set(`${source}:${lineNo}:${reference}`, {
          source,
          lineNo,
          line,
          reference,
        });
      }

      const markerIndex = line.indexOf(BOOTSTRAP_MARKER);
      if (markerIndex === -1) continue;
      bootstrapMarkerMatches += 1;

      const markerText = line.slice(markerIndex + BOOTSTRAP_MARKER.length);
      for (const match of markerText.matchAll(BOOTSTRAP_RULE_RE)) {
        const reference = match[1];
        if (!isLiteralRuleReference(reference)) continue;
        deduplicated.set(`${source}:${lineNo}:${reference}`, {
          source,
          lineNo,
          line,
          reference,
        });
      }
    }
  }

  return {
    bootstrapMarkerMatches,
    candidates: [...deduplicated.values()],
  };
}

function extractCandidates() {
  return extractCandidatesFromSources(collectCanonicalSpecFiles().map((specPath) => ({
    source: repoRelative(specPath),
    content: readFileSync(specPath, 'utf8'),
  })));
}

function findUnresolvedCandidates(candidateList, { isExempt, targetExists }) {
  return candidateList
    .filter((candidate) => !isExempt(candidate))
    .map((candidate) => ({
      ...candidate,
      expected: expectedTarget(candidate.reference),
    }))
    .filter((candidate) => !targetExists(candidate.expected));
}

function formatUnresolvedDiagnostics(unresolvedCandidates) {
  return unresolvedCandidates.map((candidate) => [
    `source=${candidate.source}:${candidate.lineNo}`,
    `reference=${candidate.reference}`,
    `expected=${candidate.expected}`,
    'classification=unresolved_canonical_rule_reference',
  ].join('\n')).join('\n---\n');
}

const canonicalSpecFiles = collectCanonicalSpecFiles();
const { bootstrapMarkerMatches, candidates } = extractCandidates();
const intentionalExemptions = candidates.filter(isIntentionalOrphan);
const forbiddenExampleFailures = candidates.filter((candidate) => (
  candidate.source === FORBIDDEN_EXAMPLE.source
  && candidate.reference === FORBIDDEN_EXAMPLE.reference
));
const unresolved = findUnresolvedCandidates(candidates, {
  isExempt: isIntentionalOrphan,
  targetExists: targetIsFile,
});

test('canonical spec collection is current-only and non-empty', () => {
  assert.ok(canonicalSpecFiles.length >= 1, 'expected at least one current canonical spec');
  for (const specPath of canonicalSpecFiles) {
    const source = repoRelative(specPath);
    assert.match(source, /^openspec\/specs\/[^/]+\/spec\.md$/);
    assert.ok(!source.includes('/changes/'), `change folder entered canonical guard input: ${source}`);
  }
});

test('canonical rule reference extraction has non-zero coverage', () => {
  assert.ok(
    candidates.length >= 1,
    'canonical_reference_candidates=0 — extraction must not produce a false green',
  );
  assert.ok(
    bootstrapMarkerMatches >= 1,
    'bootstrap_marker_matches=0 — exact marker extraction must not produce a false green',
  );
});

test('intentional orphan exemption matches exactly once', () => {
  assert.equal(
    intentionalExemptions.length,
    1,
    `intentional_exemption_matches=${intentionalExemptions.length}; expected exact source/token/semantic match once`,
  );
});

test('forbidden payload example is not classified as a rule-file target', () => {
  assert.equal(
    forbiddenExampleFailures.length,
    0,
    `forbidden_example_failures=${forbiddenExampleFailures.length}; forbidden-string prose is not a target`,
  );
});

test(
  `canonical rule references resolve (`
    + `unresolved_canonical_rule_references=${unresolved.length}, `
    + `bootstrap_marker_matches=${bootstrapMarkerMatches}, `
    + `canonical_reference_candidates=${candidates.length}, `
    + `intentional_exemption_matches=${intentionalExemptions.length}, `
    + `forbidden_example_failures=${forbiddenExampleFailures.length})`,
  () => {
    const diagnostics = formatUnresolvedDiagnostics(unresolved);

    assert.deepEqual(
      unresolved,
      [],
      `Unresolved canonical rule references (${unresolved.length}):\n${diagnostics}`,
    );
  },
);
