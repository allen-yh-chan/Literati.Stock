/**
 * requirement-task-coverage.mjs
 *
 * SSOT for ONE question: do a change's `## Requirement Ledger` and its
 * executable task ledger cover each other?
 *
 * Coverage means three things, and this module owns all three because they are
 * one answer, not three:
 *   - a `[Req: R1-R7]` range tag is never valid where exact ids are required;
 *   - a `[Req: Rn]` in the task ledger must name a real ledger row;
 *   - an `implemented` / `partial` ledger row must be claimed by some task.
 *
 * ## Why two callers exist
 *
 * `pre-pr-archive-gate.mjs` gate (m) asks it AFTER `openspec archive`, reading
 * `openspec/changes/archive/<name>/`. That is too late to be the only asker:
 * an author only learns the ledger and the tasks disagree once the archive
 * commit already exists, so the fix costs an un-archive/re-archive cycle. The
 * CLI layer of `lint-proposal-tasks-checked.mjs` asks the same question BEFORE
 * archive against the active `openspec/changes/<name>/`
 * (fix-zero-value-review-rounds R7, notes item `## 107.`).
 *
 * Two askers, one answer — which is the whole point of this module. Two
 * independently-written comparisons would let the pre-archive lint pass a
 * change the archive gate then blocks, which is worse than not having the lint
 * at all: it would teach authors that a green pre-archive run means the archive
 * gate agrees.
 *
 * ## Exact boundary of the shared guarantee
 *
 * SHARED — the whole read-to-verdict path for the coverage question: locating
 * the ledger section, parsing its table, mapping the two columns coverage is
 * keyed on (`ID`, `Disposition`), extracting `[Req: ...]` refs, and the
 * bidirectional comparison itself.
 *
 * The table read came down together with the comparison on purpose. Moving only
 * the comparison and leaving each caller to find its own ledger rows would move
 * the divergence point from "two comparisons" to "two ledger readers" — the
 * same failure shape `lib/requirement-ledger-rows.mjs` was extracted to close
 * for the id shape, one layer up. A reader that located a different table would
 * produce a different verdict from identical comparison code.
 *
 * NOT SHARED — two things, deliberately:
 *   - **Folder/task resolution.** Each caller chooses its archive or active
 *     folder and executable task carrier. Formal proposal carrier/section/table
 *     selection is shared with the count ratchet by `requirement-ledger.mjs`.
 *   - **Row-level lineage validation.** Gate (m) keeps its own checks on Root /
 *     Parent / Current / Disposition / Owner-Next-Step and invalid id shape.
 *     Structural ambiguity and duplicate recognized IDs are refused first by
 *     the shared formal reader; each caller formats that refusal. Those ask "is this ledger
 *     well-formed?", not "do the two ledgers cover each other".
 *
 * Callers also own their own message text: gate (m) writes one `stderr` block
 * with a canonical-ledger example footer, the lint emits `{kind, task, detail}`
 * violations its CLI prints line by line. So this module returns structured
 * facts, never formatted strings.
 *
 * Public API (frozen contract):
 *   - extractRequirementLedgerSection(proposalBody)
 *   - findLedgerTable(section)
 *   - collectCoverageLedgerRows(table)
 *   - extractRequirementRefs(body)
 *   - COVERAGE_REQUIRED_DISPOSITIONS
 *   - compareRequirementTaskCoverage({ ledgerRows, taskBody })
 */

import {
  hasRequirementId,
  normalizeLedgerCell,
  requirementIdScanRe,
  requirementRangeRe,
} from './requirement-ledger-rows.mjs';

export { extractRequirementLedgerSection, findLedgerTable } from './requirement-ledger.mjs';

/** Dispositions that oblige a task to claim the row. */
export const COVERAGE_REQUIRED_DISPOSITIONS = Object.freeze(['implemented', 'partial']);

/**
 * The coverage identity of each data row: `{ rowNumber, id, disposition }`.
 *
 * `rowNumber` is 1-based over the table's data rows — it is what both callers
 * name in their diagnostics, so it is derived here once rather than at each
 * call site.
 *
 * @param {{ header?: unknown, rows?: unknown } | null} table
 * @returns {{ rowNumber: number, id: string, disposition: string }[]}
 */
export function collectCoverageLedgerRows(table) {
  const header = Array.isArray(table?.header) ? table.header : [];
  const rows = Array.isArray(table?.rows) ? table.rows : [];
  const headerIndex = new Map(header.map((name, idx) => [name, idx]));
  const cell = (row, column) => normalizeLedgerCell(row[headerIndex.get(column)] || '');
  return rows.map((row, idx) => ({
    rowNumber: idx + 1,
    id: cell(row, 'ID'),
    disposition: cell(row, 'Disposition').toLowerCase(),
  }));
}

/**
 * Requirement refs carried by `[Req: ...]` tags in a task-ledger body.
 *
 * @param {unknown} body
 * @returns {{ ids: Set<string>, invalidRanges: string[] }}
 */
export function extractRequirementRefs(body) {
  const invalidRanges = [];
  const ids = new Set();
  const reqTagRe = /\[Req:\s*([^\]]+)\]/gi;
  const rangeRefRe = requirementRangeRe();
  let match;
  while ((match = reqTagRe.exec(String(body || ''))) !== null) {
    const rawRefs = normalizeLedgerCell(match[1]);
    // A range such as R1-R7 is always invalid; record it. But the SAME tag may
    // also carry standalone IDs (e.g. `R1-R3, R5`), so strip only the range
    // substrings first — never match IDs out of a range's own endpoints — then
    // extract the remaining exact IDs so the author sees every issue at once.
    const rangeMatches = rawRefs.match(rangeRefRe) || [];
    for (const range of rangeMatches) invalidRanges.push(range);
    const withoutRanges = rangeMatches.length ? rawRefs.replace(rangeRefRe, ' ') : rawRefs;
    const idMatches = withoutRanges.match(requirementIdScanRe()) || [];
    for (const id of idMatches) ids.add(id);
  }
  return { ids, invalidRanges };
}

/**
 * The bidirectional comparison. Structured facts only — each caller phrases
 * them itself.
 *
 * Rows whose `id` does not look like a requirement id are skipped on both
 * sides: a malformed id is a ledger-shape fault its own gate reports, and
 * treating it as an uncoverable row would report the same defect twice under
 * the wrong name.
 *
 * @param {object} input
 * @param {{ rowNumber: number, id: string, disposition: string }[]} input.ledgerRows
 * @param {unknown} input.taskBody - body of the executable task-ledger carrier
 * @returns {{
 *   invalidRanges: string[],
 *   unknownRefs: string[],
 *   uncoveredRows: { rowNumber: number, id: string, disposition: string }[],
 * }}
 */
export function compareRequirementTaskCoverage({ ledgerRows, taskBody }) {
  const rows = Array.isArray(ledgerRows) ? ledgerRows : [];
  const { ids: taskRefs, invalidRanges } = extractRequirementRefs(taskBody);
  const ledgerIds = new Set(rows.filter((row) => hasRequirementId(row.id)).map((row) => row.id));
  const unknownRefs = [...taskRefs].filter((ref) => !ledgerIds.has(ref));
  const uncoveredRows = rows.filter(
    (row) =>
      hasRequirementId(row.id) &&
      COVERAGE_REQUIRED_DISPOSITIONS.includes(row.disposition) &&
      !taskRefs.has(row.id)
  );
  return { invalidRanges, unknownRefs, uncoveredRows };
}
