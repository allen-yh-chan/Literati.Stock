/** Shared bounded reading of the authoritative Requirement Ledger.
 * Recognized fences/comments are inert; this is not a full Markdown parser.
 * Count, lineage and coverage consumers keep their own validation purposes.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROPOSAL_CARRIERS } from './proposal-carriers.mjs';
import { neutraliseInertMarkdown, normaliseLineEndings, extractExactH2Bodies, isExactH2Heading } from './markdown-fence-aware.mjs';
import { splitLedgerTableRow, hasRequirementId } from './requirement-ledger-rows.mjs';

export const REQUIREMENT_LEDGER_HEADING = '## Requirement Ledger';

function isSeparatorRow(cells) {
  return Array.isArray(cells) && cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c));
}

/**
 * All qualifying ID/Disposition tables in the section, with normalized cells
 * and the first malformed pipe row within each selected table.
 *
 * The header predicate is exactly the two columns coverage is keyed on, so a
 * ledger missing the other four lineage columns still yields a table the
 * coverage comparison can read — gate (m) reports those four separately.
 *
 * @param {unknown} section
 * @returns {Array<{table: {header: string[], rows: string[][]}, malformed: string|null}>}
 */
function findLedgerTables(section) {
  const tables = [];
  const lines = String(section || '').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const header = splitLedgerTableRow(lines[i]);
    if (!header) continue;
    const headerSet = new Set(header);
    if (!headerSet.has('ID') || !headerSet.has('Disposition')) continue;
    const next = splitLedgerTableRow(lines[i + 1] || '');
    if (!isSeparatorRow(next)) continue;
    const rows = [];
    let malformed = null;
    for (let j = i + 2; j < lines.length; j += 1) {
      const row = splitLedgerTableRow(lines[j]);
      if (!row) {
        const trimmed = String(lines[j] || '').trim();
        if (trimmed.startsWith('|') && !trimmed.endsWith('|')) malformed = trimmed;
        break;
      }
      if (isSeparatorRow(row)) continue;
      rows.push(row);
    }
    tables.push({ table: { header, rows }, malformed });
  }
  return tables;
}

/** Compatibility helper: first qualifying table or null; formal authority uses extractRequirementLedger. */
export function findLedgerTable(section) {
  return findLedgerTables(section)[0]?.table ?? null;
}


/** Read all present proposal carriers; absence and read failure stay distinct. */
export function readRequirementLedger(folder) {
  const carriers = [];
  for (const name of PROPOSAL_CARRIERS) {
    const file = join(folder, name);
    if (existsSync(file)) carriers.push({ name, body: readFileSync(file, 'utf8') });
  }
  return extractRequirementLedger(carriers);
}

/** Pure shared result over raw carrier bodies, in canonical filename order. */
export function extractRequirementLedger(carriers) {
  const views = carriers.map(({ name, body }) => {
    const raw = normaliseLineEndings(body);
    const blocks = extractExactH2Bodies(neutraliseInertMarkdown(raw), REQUIREMENT_LEDGER_HEADING);
    const inertOnly = blocks.count === 0 && raw.split('\n').some(line => isExactH2Heading(line, REQUIREMENT_LEDGER_HEADING));
    return { name, body, blocks, inertOnly };
  });
  const inert = views.filter(c => c.inertOnly);
  if (inert.length) return { status: 'requirement-ledger-inert-only', files: inert.map(c => c.name) };
  const live = views.filter(c => c.blocks.count > 0);
  if (!live.length) return { status: carriers.length ? 'no-requirement-ledger' : 'no-proposal-carrier' };
  if (live.length > 1) return { status: 'ambiguous-proposal-carrier', files: live.map(c => c.name) };
  const carrier = live[0];
  if (carrier.blocks.count > 1) return { status: 'duplicate-requirement-ledger', file: carrier.name };
  const section = carrier.blocks.bodies[0];
  const tables = findLedgerTables(section);
  if (tables.length > 1) return { status: 'ambiguous-requirement-table', file: carrier.name };
  const selected = tables[0];
  const table = selected?.table ?? null;
  const result = { status: 'ok', file: carrier.name, body: carrier.body, section, table, ids: [], duplicate: null, malformed: null };
  if (!table) return { ...result, status: 'requirement-ledger-table-missing' };
  result.malformed = selected.malformed;
  const index = table.header.indexOf('ID');
  const seen = new Set();
  for (const row of table.rows) {
    const id = row[index];
    if (!hasRequirementId(id)) continue;
    if (seen.has(id)) { result.duplicate ??= id; continue; }
    seen.add(id); result.ids.push(id);
  }
  if (result.malformed !== null) result.status = 'malformed-requirement-row';
  else if (result.duplicate !== null) result.status = 'duplicate-requirement-id';
  return result;
}

/** Existing single-body API; structural ambiguity is a typed diagnostic. */
export function extractRequirementLedgerSection(body) {
  const result = extractRequirementLedger([{ name: 'proposal', body }]);
  if (result.status === 'no-requirement-ledger') return null;
  if (result.status === 'ok' || result.status === 'requirement-ledger-table-missing') return result.section;
  const error = new Error(result.status);
  error.reason = result.status;
  throw error;
}
