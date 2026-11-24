/**
 * gfm-table.mjs
 *
 * Split one GFM table row without treating literal pipes as delimiters.
 *
 * A pipe is literal when it is backslash-escaped or is inside a matched
 * backtick code span. The latter is intentionally recognized here because
 * control-plane evidence tables may carry executable branches such as
 * `b|d`; silently dropping such a row would turn a readability hard gate
 * into a false blocker.
 *
 * Raw cells are returned. Trimming and other normalization belong to each
 * caller because different tables have different content contracts.
 *
 * Shared between `.devpro/scripts/pre-pr-archive-gate.mjs` (`splitTableRow`,
 * Requirement Ledger parsing) and `.devpro/scripts/rule-load-ledger.mjs`
 * (`extractAgentsIndexRows`, AGENTS.md trigger index parsing). Both call sites
 * previously used naive `.split('|')`; this module is their single SoT.
 * `.devpro/scripts/hooks/post-pr-completion-check.mjs` intentionally stays out:
 * its pipe joins a path list and is not a GFM-table delimiter.
 */

function backtickRunLength(value, start) {
  let end = start;
  while (end < value.length && value[end] === '`') end += 1;
  return end - start;
}

function hasClosingBacktickRun(value, start, expectedLength) {
  for (let i = start; i < value.length;) {
    if (value[i] !== '`') {
      i += 1;
      continue;
    }
    const length = backtickRunLength(value, i);
    if (length === expectedLength) return true;
    i += length;
  }
  return false;
}

export function splitGfmTableRow(line) {
  const value = String(line == null ? '' : line);
  const cells = [];
  let cell = '';
  let codeSpanDelimiterLength = 0;

  for (let i = 0; i < value.length; i += 1) {
    const character = value[i];

    if (character === '`') {
      const runLength = backtickRunLength(value, i);
      if (codeSpanDelimiterLength === runLength) {
        codeSpanDelimiterLength = 0;
      } else if (
        codeSpanDelimiterLength === 0 &&
        hasClosingBacktickRun(value, i + runLength, runLength)
      ) {
        codeSpanDelimiterLength = runLength;
      }
      cell += value.slice(i, i + runLength);
      i += runLength - 1;
      continue;
    }

    if (character === '\\') {
      const next = i + 1 < value.length ? value[i + 1] : '';
      if (next === '|') {
        cell += '|';
        i += 1;
      } else if (codeSpanDelimiterLength > 0 || next === '') {
        cell += '\\';
      } else {
        cell += `\\${next}`;
        i += 1;
      }
      continue;
    }

    if (character === '|' && codeSpanDelimiterLength === 0) {
      cells.push(cell);
      cell = '';
      continue;
    }
    cell += character;
  }

  cells.push(cell);
  return cells;
}
