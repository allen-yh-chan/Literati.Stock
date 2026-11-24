/**
 * gfm-table.test.mjs
 *
 * Unit tests for .devpro/scripts/lib/gfm-table.mjs
 *
 * Covers:
 *   - escape-free row is byte-identical to `.split('|')` (incl. head/tail sentinel '')
 *   - escaped pipe (`\|`) merges into a single cell as a literal `|`
 *   - escaped backslash followed by a delimiter pipe (`\\|`) splits correctly
 *   - dangling trailing backslash does not crash and is preserved verbatim
 *   - matched code-span pipes remain literal while unmatched backticks do not hide delimiters
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitGfmTableRow } from '../../lib/gfm-table.mjs';

test('splitGfmTableRow preserves ordinary split delimiters', () => {
  const line = '|a|b|c|';
  assert.deepEqual(splitGfmTableRow(line), line.split('|'));
});

test('splitGfmTableRow keeps an escaped pipe in one cell', () => {
  assert.deepEqual(splitGfmTableRow('|a\\|b|c|'), ['', 'a|b', 'c', '']);
});

test('splitGfmTableRow treats an even-backslash pipe as a delimiter', () => {
  assert.deepEqual(splitGfmTableRow('\\\\|'), ['\\\\', '']);
});

test('splitGfmTableRow preserves a dangling backslash', () => {
  assert.deepEqual(splitGfmTableRow('a\\'), ['a\\']);
});

test('splitGfmTableRow keeps a pipe inside a matched code span in one cell', () => {
  assert.deepEqual(splitGfmTableRow('|a `b|d` c|e|'), ['', 'a `b|d` c', 'e', '']);
  assert.deepEqual(splitGfmTableRow('|a ``b`|d`` c|e|'), ['', 'a ``b`|d`` c', 'e', '']);
  assert.deepEqual(splitGfmTableRow('|a `b|c\\`|d|'), ['', 'a `b|c\\`', 'd', '']);
});

test('splitGfmTableRow does not let an unmatched backtick hide delimiters', () => {
  assert.deepEqual(splitGfmTableRow('|a `b|d|'), ['', 'a `b', 'd', '']);
});

test('splitGfmTableRow is total for empty input', () => {
  assert.deepEqual(splitGfmTableRow(null), ['']);
  assert.deepEqual(splitGfmTableRow(undefined), ['']);
  assert.deepEqual(splitGfmTableRow(''), ['']);
});
