/**
 * primitives.test.mjs
 *
 * Unit tests for .devpro/scripts/lib/primitives.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  sha256Hex,
  nowIso,
  isBlank,
  escapeRegExp,
  isRepositorySlug,
  isPlainObject,
  isStrictPlainObject,
} from '../../lib/primitives.mjs';

test('sha256Hex hashes a utf8 string', () => {
  assert.equal(
    sha256Hex('hello'),
    createHash('sha256').update('hello', 'utf8').digest('hex'),
  );
});

test('sha256Hex Buffer matches the same utf8 string', () => {
  const text = 'hello';
  assert.equal(sha256Hex(Buffer.from(text, 'utf8')), sha256Hex(text));
});

test('isBlank treats undefined, null, and whitespace as blank', () => {
  assert.equal(isBlank(undefined), true);
  assert.equal(isBlank(null), true);
  assert.equal(isBlank(''), true);
  assert.equal(isBlank('  '), true);
  assert.equal(isBlank('x'), false);
  assert.equal(isBlank(0), false);
});

test('escapeRegExp escapes regex metacharacters', () => {
  assert.equal(escapeRegExp('a.b+c'), 'a\\.b\\+c');
  assert.equal(escapeRegExp('[x]'), '\\[x\\]');
});

test('isPlainObject is loose; isStrictPlainObject is prototype-strict', () => {
  assert.equal(isPlainObject({ a: 1 }), true);
  assert.equal(isStrictPlainObject({ a: 1 }), true);

  const nullProto = Object.create(null);
  assert.equal(isPlainObject(nullProto), true);
  assert.equal(isStrictPlainObject(nullProto), false);

  assert.equal(isPlainObject(new Date()), true);
  assert.equal(isStrictPlainObject(new Date()), false);

  assert.equal(isPlainObject([]), false);
  assert.equal(isStrictPlainObject([]), false);
  assert.equal(isPlainObject(null), false);
  assert.equal(isStrictPlainObject(null), false);
  assert.equal(isPlainObject('obj'), false);
});

test('isRepositorySlug accepts owner/repo and rejects blanks', () => {
  assert.equal(isRepositorySlug('owner/repo'), true);
  assert.equal(isRepositorySlug('Org-Name/pkg.name'), true);
  assert.equal(isRepositorySlug(''), false);
  assert.equal(isRepositorySlug(null), false);
  assert.equal(isRepositorySlug('noslash'), false);
});

test('nowIso returns an ISO-8601 timestamp', () => {
  assert.match(nowIso(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
});
