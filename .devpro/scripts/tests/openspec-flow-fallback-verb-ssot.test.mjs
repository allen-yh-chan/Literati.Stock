import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { repoPath } from './lib/repo-root.mjs';

const FALLBACK = repoPath('.devpro/agent-rules/openspec-flow-fallback.md');
const SSOT = repoPath('.devpro/agent-rules/preflight-checklist.md');
const OPENSPEC_FLOW_SPEC = repoPath('openspec/specs/openspec-flow/spec.md');

const EXPECTED_VERBS = [
  'add', 'fix', 'refactor', 'remove', 'migrate', 'update', 'sync',
  'docs', 'amend', 'strengthen', 'wire', 'clarify', 'enforce', 'revert',
  'rationalize'
];

function extractPoint2Section(content) {
  const lines = content.split('\n');
  const startIdx = lines.findIndex((l) => /^2\.\s+\*\*動詞白名單\*\*/.test(l));
  assert.ok(startIdx >= 0, 'fallback 找不到點 2「動詞白名單」段起始行');
  const endRel = lines.slice(startIdx + 1).findIndex((l) => /^3\.\s/.test(l));
  const endIdx = endRel >= 0 ? startIdx + 1 + endRel : lines.length;
  return lines.slice(startIdx, endIdx).join('\n');
}

function extractMarkerVerbs(content) {
  const start = content.indexOf('<!-- branch-verb-whitelist:start -->');
  const end = content.indexOf('<!-- branch-verb-whitelist:end -->', start);
  assert.ok(start >= 0 && end > start, 'preflight-checklist.md 缺 branch verb marker 區塊');
  return [...content.slice(start, end).matchAll(/^\s*- `([^`]+)`/gm)].map((m) => m[1]);
}

function extractRequirement(content, headingPattern) {
  const match = content.match(headingPattern);
  assert.ok(match, 'openspec-flow spec 缺 Verb Whitelist requirement');
  const startIdx = match.index;
  const endIdx = content.indexOf('\n### Requirement:', startIdx + 1);
  return content.slice(startIdx, endIdx === -1 ? undefined : endIdx);
}

test('fallback 點 2 段落含 preflight-checklist SSOT pointer', () => {
  const section = extractPoint2Section(readFileSync(FALLBACK, 'utf8'));
  assert.match(section, /preflight-checklist/,
    '點 2 段落未含 preflight-checklist pointer（pointer 必須綁在點 2 內，不能僅出現在他處）');
});

test('fallback 點 2 段落不再內嵌任何動詞清單（drift 變體覆蓋）', () => {
  const section = extractPoint2Section(readFileSync(FALLBACK, 'utf8'));

  assert.doesNotMatch(section, /七\s*動詞/,
    '點 2 仍含「七動詞 / 七 動詞」字樣，drift 未清除');
  assert.doesNotMatch(section, /\d+\s*動詞開頭/,
    '點 2 仍宣告動詞數量（例如「12 動詞開頭」）；數量宣告應只出現在 SSOT，本檔僅 pointer');

  for (const verb of EXPECTED_VERBS) {
    const literalBacktick = new RegExp('`' + verb + '`');
    assert.doesNotMatch(section, literalBacktick,
      `點 2 仍以 backtick 列舉動詞 \`${verb}\`，應改純 pointer 不重複列舉`);
  }
});

test('preflight-checklist.md 仍為 marker whitelist SSOT（unchanged guard）', () => {
  const content = readFileSync(SSOT, 'utf8');
  assert.match(content, /branch-verb-whitelist:start/, 'SSOT 應含 whitelist marker 起點');
  assert.match(content, /branch-verb-whitelist:end/, 'SSOT 應含 whitelist marker 終點');
  for (const verb of EXPECTED_VERBS) {
    assert.match(content, new RegExp('`' + verb + '`'),
      `SSOT 缺動詞 \`${verb}\``);
  }
});

test('openspec-flow spec uses marker SSOT instead of hardcoded whitelist count', () => {
  const markerVerbs = extractMarkerVerbs(readFileSync(SSOT, 'utf8'));
  const section = extractRequirement(
    readFileSync(OPENSPEC_FLOW_SPEC, 'utf8'),
    /^### Requirement: Pre-flight Verb Whitelist.*$/m,
  );

  assert.equal(markerVerbs.length, EXPECTED_VERBS.length,
    'test fixture EXPECTED_VERBS must stay aligned with preflight marker');
  assert.match(section, /preflight-checklist\.md/,
    'capability spec 應指向 preflight-checklist.md marker SSOT');
  assert.doesNotMatch(section, /\bexactly\s+(?:twelve|\d+)\b/i,
    'capability spec 不得 hardcode exact verb count');
  assert.doesNotMatch(section, /\b(?:eleven|twelve)-verb\b/i,
    'scenario 名稱不得保留 stale fixed-count wording');
});
