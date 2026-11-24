/**
 * task-ledger-resolution.mjs
 *
 * SSOT for executable task-ledger carrier resolution. Shared by:
 *   - lint-proposal-tasks-checked.mjs (pre-archive Step 3.6)
 *   - pre-pr-archive-gate.mjs check (l) prove-it scanning (any-marker)
 *   - pre-pr-archive-gate.mjs check (m) task-coverage body (ordered-first)
 *   - pre-pr-archive-gate.mjs check (o) via lintProposalTasksChecked
 *
 * Distinct from proposalCandidates (proposal.md-first), which answers "where is
 * the proposal document", not "where is the executable task ledger".
 *
 * Public API (frozen contract — design.md D1 / D2):
 *   - TASK_LEDGER_CARRIER_CANDIDATES
 *   - DEFAULT_PROVE_IT_RE
 *   - resolveExecutableTaskLedgerCarrier(changeFolderAbs)
 *   - listExistingTaskLedgerCarriers(changeFolderAbs)
 *   - findProveItInTaskLedgerCarriers(changeFolderAbs, proveItRe?)
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const TASK_LEDGER_CARRIER_CANDIDATES = Object.freeze([
  'proposal-mini.md',
  'tasks.md',
]);

/** Accepted prove-it markers (case-insensitive). */
export const DEFAULT_PROVE_IT_RE = /prove[-\s]it|failing test|重現.{0,10}bug/i;

/**
 * @param {string} changeFolderAbs
 * @returns {{ absolutePath: string, filename: string }[]}
 */
export function listExistingTaskLedgerCarriers(changeFolderAbs) {
  const found = [];
  for (const filename of TASK_LEDGER_CARRIER_CANDIDATES) {
    const absolutePath = join(changeFolderAbs, filename);
    if (existsSync(absolutePath)) {
      found.push({ absolutePath, filename });
    }
  }
  return found;
}

/**
 * Ordered first-existing executable task-ledger carrier.
 * @param {string} changeFolderAbs
 * @returns {{ absolutePath: string, filename: string } | null}
 */
export function resolveExecutableTaskLedgerCarrier(changeFolderAbs) {
  const existing = listExistingTaskLedgerCarriers(changeFolderAbs);
  return existing.length > 0 ? existing[0] : null;
}

/**
 * Prove-it scan across all existing task-ledger carriers (any-marker).
 * Executable-ledger identity remains ordered-first via
 * resolveExecutableTaskLedgerCarrier; this API only answers "does any carrier
 * body contain a prove-it marker?".
 *
 * @param {string} changeFolderAbs
 * @param {RegExp} [proveItRe]
 * @returns {{
 *   ok: boolean,
 *   matchedFilename: string | null,
 *   carriersChecked: string[],
 *   reason: 'no-carrier' | 'no-marker' | 'matched'
 * }}
 */
export function findProveItInTaskLedgerCarriers(
  changeFolderAbs,
  proveItRe = DEFAULT_PROVE_IT_RE
) {
  const existing = listExistingTaskLedgerCarriers(changeFolderAbs);
  const carriersChecked = existing.map((c) => c.filename);
  if (existing.length === 0) {
    return {
      ok: false,
      matchedFilename: null,
      carriersChecked,
      reason: 'no-carrier',
    };
  }
  for (const carrier of existing) {
    let body;
    try {
      body = readFileSync(carrier.absolutePath, 'utf8');
    } catch {
      continue;
    }
    if (proveItRe.test(body)) {
      return {
        ok: true,
        matchedFilename: carrier.filename,
        carriersChecked,
        reason: 'matched',
      };
    }
  }
  return {
    ok: false,
    matchedFilename: null,
    carriersChecked,
    reason: 'no-marker',
  };
}
