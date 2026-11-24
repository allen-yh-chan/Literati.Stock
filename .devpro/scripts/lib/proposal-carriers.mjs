/**
 * proposal-carriers.mjs
 *
 * SSOT for the proposal carrier filenames and their canonical priority order.
 *
 * A change folder may hold `proposal.md` (full) or `proposal-mini.md` (B-mini).
 * General artifact readers answering "which file is the proposal?" resolve it the
 * same way: **first existing wins, `proposal.md` first**. That order is not a
 * preference — it is the order `pre-pr-archive-gate.mjs` has always used, so a
 * reader that reverses it would disagree with the archive gate about which
 * document a change's requirements live in.
 *
 * Formal Requirement Ledger reading is a narrower question: requirement-ledger.mjs
 * scans this same ordered list, requires one live Ledger and refuses ambiguity.
 * It does not waive general artifact-class or executable-task-carrier checks.
 *
 * The list lived as three independent literals (`pre-pr-archive-gate.mjs`,
 * `lint-requirement-count-ratchet.mjs`, `report-governance-ratio.mjs`). Three
 * copies of an ordered list is three chances for the order to drift silently,
 * which is the same failure mode `lib/requirement-ledger-rows.mjs` was
 * extracted to close for the id shape.
 */

/** Proposal carriers, highest priority first. Resolution is first-existing. */
export const PROPOSAL_CARRIERS = Object.freeze(['proposal.md', 'proposal-mini.md']);
