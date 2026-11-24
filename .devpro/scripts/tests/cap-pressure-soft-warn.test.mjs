import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAP_PRESSURE_SOFT_WARN_MAX_BYTES,
  CAP_PRESSURE_SOFT_WARN_META_RESERVE,
  emitCapPressureSoftWarn,
  formatCapPressurePath,
  isCanonicalCapPressureSoftWarn,
} from '../lib/cap-pressure-soft-warn.mjs';

function renderCapPressureSoftWarn(files) {
  const chunks = [];
  emitCapPressureSoftWarn(files, (chunk) => chunks.push(chunk));
  return chunks.join('');
}

test('formatCapPressurePath JSON-encodes newline and control bytes', () => {
  assert.equal(formatCapPressurePath('a\nb'), '"a\\nb"');
  assert.equal(formatCapPressurePath('a\u0000b'), '"a\\u0000b"');
  assert.equal(formatCapPressurePath('AGENTS.md'), '"AGENTS.md"');
});

test('emitCapPressureSoftWarn encodes paths as single-line JSON', () => {
  const chunks = [];
  emitCapPressureSoftWarn(
    [{ path: '.devpro/agent-rules/evil\nline.md', utilization: 120 }],
    (c) => chunks.push(c)
  );
  const out = chunks.join('');
  assert.match(out, /path="\.devpro\/agent-rules\/evil\\nline\.md"/);
  const pathLines = out.split('\n').filter((l) => l.startsWith('soft-warn cap-pressure=over path='));
  assert.equal(pathLines.length, 1);
  assert.equal(pathLines[0].includes('\n'), false);
  assert.doesNotMatch(out, /path=\.devpro\/agent-rules\/evil\n/);
});

test('emitCapPressureSoftWarn truncates when aggregate path bytes exceed budget', () => {
  const chunks = [];
  const files = Array.from({ length: 6 }, (_, i) => ({
    path: `.devpro/agent-rules/p${i}-${'b'.repeat(400)}.md`,
    utilization: 200 - i,
  }));
  emitCapPressureSoftWarn(files, (c) => chunks.push(c));
  const out = chunks.join('');
  assert.match(out, /truncated=true omitted=\d+ bytes=\d+/);
  const pathLines = out.split('\n').filter((l) => l.startsWith('soft-warn cap-pressure=over path='));
  assert.ok(pathLines.length < 6, `expected byte-budget omit, got ${pathLines.length}`);
  assert.ok(Buffer.byteLength(out, 'utf8') <= CAP_PRESSURE_SOFT_WARN_MAX_BYTES);
});

test('isCanonicalCapPressureSoftWarn accepts complete bounded emitter output', () => {
  const complete = renderCapPressureSoftWarn([
    { path: '.devpro/agent-rules/one.md', utilization: 125.5 },
    { path: '.devpro/agent-rules/two.md', utilization: 101 },
  ]);
  const truncated = renderCapPressureSoftWarn(Array.from({ length: 12 }, (_, index) => ({
    path: `.devpro/agent-rules/${String(index).padStart(2, '0')}.md`,
    utilization: 200 - index,
  })));

  assert.equal(isCanonicalCapPressureSoftWarn(Buffer.from(complete)), true);
  assert.equal(isCanonicalCapPressureSoftWarn(truncated), true);
});

test('isCanonicalCapPressureSoftWarn rejects path bytes beyond the emitter budget', () => {
  const pathLine = `soft-warn cap-pressure=over path=${JSON.stringify('x'.repeat(1840))} utilization=120\n`;
  const body = `soft-warn cap-pressure=over count=1 showing=1\n${pathLine}`;
  assert.ok(Buffer.byteLength(pathLine) > CAP_PRESSURE_SOFT_WARN_MAX_BYTES - CAP_PRESSURE_SOFT_WARN_META_RESERVE);
  assert.ok(Buffer.byteLength(body) < CAP_PRESSURE_SOFT_WARN_MAX_BYTES);
  assert.equal(isCanonicalCapPressureSoftWarn(body), false);
});

test('isCanonicalCapPressureSoftWarn rejects invalid raw UTF-8 before lossy path validation', () => {
  const raw = Buffer.concat([
    Buffer.from('soft-warn cap-pressure=over count=1 showing=1\nsoft-warn cap-pressure=over path="'),
    Buffer.from([0xc3]),
    Buffer.from('" utilization=120\n'),
  ]);
  const lossy = raw.toString('utf8');
  assert.equal(lossy.includes('\uFFFD'), true);
  assert.equal(isCanonicalCapPressureSoftWarn(lossy), true, 'lossy text alone looks canonical');
  assert.equal(isCanonicalCapPressureSoftWarn(raw), false, 'raw invalid UTF-8 must fail closed');
});

test('isCanonicalCapPressureSoftWarn rejects malformed, inconsistent, mixed, and unbounded bodies', () => {
  const pathLine = 'soft-warn cap-pressure=over path="a.md" utilization=120\n';
  const canonical = `soft-warn cap-pressure=over count=1 showing=1\n${pathLine}`;
  const oversizedPathLine = `soft-warn cap-pressure=over path=${JSON.stringify('x'.repeat(2100))} utilization=120\n`;
  const cases = [
    ['malformed aggregate', `soft-warn cap-pressure=over count=x showing=1\n${pathLine}`],
    ['mixed unrelated stderr', `${canonical}unknown warning\n`],
    ['wrong count', `soft-warn cap-pressure=over count=2 showing=1\n${pathLine}`],
    ['wrong showing', `soft-warn cap-pressure=over count=1 showing=0\n${pathLine}`],
    ['missing path line', 'soft-warn cap-pressure=over count=1 showing=1\n'],
    ['malformed JSON path', 'soft-warn cap-pressure=over count=1 showing=1\nsoft-warn cap-pressure=over path="a.md utilization=120\n'],
    ['noncanonical JSON path', 'soft-warn cap-pressure=over count=1 showing=1\nsoft-warn cap-pressure=over path="a\\u002emd" utilization=120\n'],
    ['utilization at cap', 'soft-warn cap-pressure=over count=1 showing=1\nsoft-warn cap-pressure=over path="a.md" utilization=100\n'],
    ['invalid utilization', 'soft-warn cap-pressure=over count=1 showing=1\nsoft-warn cap-pressure=over path="a.md" utilization=invalid\n'],
    ['infinite utilization', 'soft-warn cap-pressure=over count=1 showing=1\nsoft-warn cap-pressure=over path="a.md" utilization=Infinity\n'],
    ['noncanonical utilization', 'soft-warn cap-pressure=over count=1 showing=1\nsoft-warn cap-pressure=over path="a.md" utilization=1.20e2\n'],
    ['truncated metadata missing bytes', `soft-warn cap-pressure=over count=2 showing=1 truncated=true omitted=1\n${pathLine}`],
    ['wrong omitted', `soft-warn cap-pressure=over count=2 showing=1 truncated=true omitted=2 bytes=${Buffer.byteLength(pathLine)}\n${pathLine}`],
    ['wrong path bytes', `soft-warn cap-pressure=over count=2 showing=1 truncated=true omitted=1 bytes=1\n${pathLine}`],
    ['unneeded truncation', `soft-warn cap-pressure=over count=1 showing=1 truncated=true omitted=0 bytes=${Buffer.byteLength(pathLine)}\n${pathLine}`],
    ['over byte cap', `soft-warn cap-pressure=over count=2 showing=1 truncated=true omitted=1 bytes=${Buffer.byteLength(oversizedPathLine)}\n${oversizedPathLine}`],
    ['missing final newline', canonical.slice(0, -1)],
    ['extra blank line', `${canonical}\n`],
  ];

  for (const [name, body] of cases) {
    assert.equal(isCanonicalCapPressureSoftWarn(body), false, name);
  }
});
