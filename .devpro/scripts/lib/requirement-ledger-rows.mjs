/**
 * requirement-ledger-rows.mjs
 *
 * SSOT for recognising `R<n>` rows in a `## Requirement Ledger` table.
 *
 * Extracted from `pre-pr-archive-gate.mjs` (gate (m)), which owned these as
 * nested closures, and now consumed by `lint-requirement-count-ratchet.mjs`
 * too.
 *
 * ## Exact boundary of the shared guarantee
 *
 * SHARED — **row recognition**: cell normalisation, row splitting, and the
 * requirement-id shape. Given the same ledger *section body*, both gates
 * classify the same cells as requirement ids. That is what closes the failure
 * this lib was extracted for: a ratchet built on a narrower id shape letting
 * `R4a`/`R4b` growth through while gate (m) sees it.
 *
 * FORMAL LEDGER SELECTION — `lib/requirement-ledger.mjs` now selects the
 * authoritative carrier, recognized live H2 section and ID/Disposition table
 * for the ratchet and archive/pre-archive coverage readers. This module still
 * owns row/cell recognition, not document selection. `collectRequirementIds`
 * remains a lower-level section scanner for existing callers and tests.
 *
 * NOT SHARED — totals and consumer validation duties:
 * Totals have different purposes: the ratchet counts distinct recognized IDs;
 * the archive gate validates every selected row and its lineage/coverage.
 * Do not describe the bounded fence/comment reader as a full Markdown parser
 * or a control against deliberate author/history manipulation.
 *
 * Public API (frozen contract):
 *   - REQUIREMENT_ID_BODY / REQUIREMENT_ID_RE
 *   - requirementIdScanRe() / requirementRangeRe()
 *   - normalizeLedgerCell(cell)
 *   - splitLedgerTableRow(line)
 *   - hasRequirementId(cell)
 *   - collectRequirementIds(sectionBody)
 */

import { splitGfmTableRow } from './gfm-table.mjs';

/**
 * Canonical id shape as a pattern *source*: `R` + digits + optional
 * alphanumeric/dot/underscore suffix (R4a, R4.1, R4_x).
 *
 * Exported as a source string, not only as a compiled anchored regex, because
 * the same shape is needed unanchored when scanning `[Req: R1, R2]` task tags.
 * Re-typing the shape at each scan site is how the three copies that preceded
 * this module drifted apart.
 */
export const REQUIREMENT_ID_BODY = String.raw`R\d+[A-Za-z0-9._]*`;

/** Canonical id shape, anchored, for testing one whole cell. */
export const REQUIREMENT_ID_RE = new RegExp(`^${REQUIREMENT_ID_BODY}$`, 'u');

/**
 * Fresh global scanner for standalone ids inside free text.
 * A factory, not a shared constant: `g` regexes carry `lastIndex`, so sharing
 * one instance across call sites makes results depend on call order.
 * @returns {RegExp}
 */
export function requirementIdScanRe() {
  return new RegExp(REQUIREMENT_ID_BODY, 'g');
}

/**
 * Fresh global scanner for range references such as `R1-R7` / `R1\u2013R7` / `R1-7`,
 * which are always invalid where exact ids are required. Same factory rationale.
 * @returns {RegExp}
 */
export function requirementRangeRe() {
  return new RegExp(
    `\\b${REQUIREMENT_ID_BODY}\\s*[-\u2013\u2014]\\s*R?\\d+[A-Za-z0-9._]*\\b`,
    'g',
  );
}

/**
 * Canonical ledger-cell normalisation: `<br>` to space, drop code-span
 * backticks, collapse whitespace, trim.
 * @param {unknown} cell
 * @returns {string}
 */
export function normalizeLedgerCell(cell) {
  return String(cell || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalised data cells of a GFM table row, or null when the line is not one.
 * @param {unknown} line
 * @returns {string[] | null}
 */
export function splitLedgerTableRow(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
  return splitGfmTableRow(trimmed)
    .slice(1, -1)
    .map((cell) => normalizeLedgerCell(cell));
}

/**
 * @param {unknown} cell
 * @returns {boolean}
 */
export function hasRequirementId(cell) {
  return REQUIREMENT_ID_RE.test(normalizeLedgerCell(cell));
}

/**
 * Ordered requirement ids in a Requirement Ledger section body, plus the first
 * duplicate and the first malformed row if any. Both make a count untrustworthy,
 * so callers that count MUST fail closed rather than silently de-duplicate or
 * silently skip.
 *
 * `malformed` exists because skipping an unparseable row is fail-OPEN for a
 * ratchet: a row that opens with `|` but omits the closing `|` still renders
 * as a table row, yet `splitLedgerTableRow` rejects it — so the requirement
 * would vanish from the count and let growth through. Reporting it lets the
 * caller refuse instead of under-counting.
 *
 * @param {string} sectionBody
 * @returns {{ ids: string[], duplicate: string | null, malformed: string | null }}
 */
export function collectRequirementIds(sectionBody) {
  const ids = [];
  const seen = new Set();
  let duplicate = null;
  let malformed = null;
  for (const line of String(sectionBody ?? '').split('\n')) {
    const cells = splitLedgerTableRow(line);
    if (!cells || cells.length === 0) {
      const trimmed = String(line || '').trim();
      if (malformed === null && trimmed.startsWith('|') && !trimmed.endsWith('|')) {
        malformed = trimmed;
      }
      continue;
    }
    const id = cells[0];
    if (!hasRequirementId(id)) continue;
    if (seen.has(id)) {
      if (duplicate === null) duplicate = id;
      continue;
    }
    seen.add(id);
    ids.push(id);
  }
  return { ids, duplicate, malformed };
}
