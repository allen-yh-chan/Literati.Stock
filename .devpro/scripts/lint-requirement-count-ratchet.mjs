#!/usr/bin/env node
/**
 * Requirement-count ratchet.
 *
 * Blocks distinct recognized-ID count growth in the formal Ledger table beyond the baseline that
 * `decisions.md` names in a structured `## Requirement Baseline Ledger` table.
 *
 * Zero semantic judgement by construction: the gate never reads *why* a
 * baseline moved and never scans free text for a clearing token. It only
 * confirms that a structured, uniquely-identified, chain-consistent row —
 * bound to a real decision heading — says the baseline moved. An author who
 * wants to grow the requirement set can still add such a row; the guarantee is
 * that growth leaves a named, auditable trace requiring a deliberate act, not
 * that growth cannot happen.
 *
 * What that trace is worth, stated exactly, because an imprecise claim is what
 * a reviewer will hold this to:
 *   - Transitions from a baseline this branch already committed are verified
 *     append-only against Git (`--base <change-base-ref>`). Editing a row that
 *     an earlier commit already declared is refused; raising the baseline is
 *     possible only by APPENDING a row.
 *   - The ORIGIN is author-asserted. Nothing stops a first commit from
 *     declaring 5, or 50 — there is no earlier state to ratchet from. That is
 *     inherent, not a hole to be closed.
 *   - Rewriting branch history is out of the threat model. It defeats the
 *     anchor, and it leaves the PR diff and force-push record as the evidence.
 *
 * Formal Requirement Ledger selection is shared by `lib/requirement-ledger.mjs`
 * with archive and pre-archive coverage consumers. Recognized fence/comment
 * examples are inert; carrier, section and table ambiguity are typed refusals.
 * Row/cell recognition stays in `lib/requirement-ledger-rows.mjs`.
 * The consumers retain their distinct count, lineage and coverage purposes.
 * This is a bounded accidental-error control, not full Markdown recognition.

 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { execGitFileSyncWithRetry } from './lib/git-exec-retry.mjs';
import { pathToFileURL } from 'node:url';
import { runChangeFolderLinterCli } from './lib/openspec-linter-cli.mjs';
import { splitGfmTableRow } from './lib/gfm-table.mjs';
import { PROPOSAL_CARRIERS } from './lib/proposal-carriers.mjs';
import {
  isAtxHeadingLine,
  isExactH2Heading,
  neutraliseInertMarkdown as sharedNeutraliseInertMarkdown,
  normaliseLineEndings as sharedNormaliseLineEndings,
} from './lib/markdown-fence-aware.mjs';

// Carrier order is not re-typed here: it comes from the same frozen list
// `pre-pr-archive-gate.mjs` resolves proposals with. Re-exported so callers of
// this lint keep one import site.
export { PROPOSAL_CARRIERS };

import { readRequirementLedger, REQUIREMENT_LEDGER_HEADING } from './lib/requirement-ledger.mjs';
export { REQUIREMENT_LEDGER_HEADING } from './lib/requirement-ledger.mjs';
export const BASELINE_LEDGER_HEADING = '## Requirement Baseline Ledger';

/** Closed enum for the `trigger` column. */
const TRIGGER_INITIAL = 'initial';
const TRIGGER_SCOPE_CHANGE = 'scope-change';
const VALID_TRIGGERS = Object.freeze([TRIGGER_INITIAL, TRIGGER_SCOPE_CHANGE]);

const DECISION_ID_RE = /^D\d+$/u;
const NON_NEGATIVE_INT_RE = /^\d+$/u;
/** ATX headings may carry up to three leading spaces (CommonMark). */
const DECISION_HEADING_RE = /^ {0,3}#{2,3}\s+(D\d+)\b/u;

/**
 * Fence delimiter / closesFence / neutralise / exactH2Blocks — SSOT is
 * `lib/markdown-fence-aware.mjs`. Re-exported so existing imports keep working.
 */
export function normaliseLineEndings(content) {
  return sharedNormaliseLineEndings(content);
}

export function neutraliseInertMarkdown(content) {
  return sharedNeutraliseInertMarkdown(content);
}

/**
 * Bodies of an exact H2 block. Input MUST already be neutralised for the
 * live view — this scanner itself is fence-unaware so the inert-only probe
 * can still see a heading that only exists inside a fence on the
 * line-normalised view. Terminates on the next H2 or H1.
 *
 * @param {string} neutralisedContent
 * @param {string} heading exact H2 line (without trailing newline)
 * @returns {{ count: number, bodies: string[] }}
 */
export function exactH2Blocks(neutralisedContent, heading) {
  const lines = String(neutralisedContent ?? '').split('\n');
  const bodies = [];
  /** @type {string[] | null} */
  let current = null;
  for (const line of lines) {
    if (isExactH2Heading(line, heading)) {
      if (current !== null) bodies.push(current.join('\n'));
      current = [];
      continue;
    }
    if (current !== null) {
      if (isAtxHeadingLine(line, 2) || isAtxHeadingLine(line, 1)) {
        bodies.push(current.join('\n'));
        current = null;
        continue;
      }
      current.push(line);
    }
  }
  if (current !== null) bodies.push(current.join('\n'));
  return { count: bodies.length, bodies };
}

// Local blankSpan / scanLiveLineForComments / fence SM removed — owned by markdown-fence-aware.mjs.


/**
 * Data cells of a GFM table row, or null when the line is not a table row.
 * Used for the baseline ledger, whose cells are literal tokens rather than
 * prose (so it keeps its own splitter instead of the ledger-cell normaliser).
 * @param {string} line
 * @returns {string[] | null}
 */
function tableRowCells(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return null;
  const parts = splitGfmTableRow(trimmed);
  const cells = parts.slice(1, -1).map((c) => c.trim());
  return cells.length > 0 ? cells : null;
}

/** @param {string[]} cells */
function isSeparatorRow(cells) {
  return cells.every((c) => /^:?-+:?$/u.test(c));
}

/**
 * Parse and chain-validate the baseline ledger table.
 * @param {string} block body of the single `## Requirement Baseline Ledger` H2
 * @param {Set<string>} decisionIds decision ids that have a real heading
 * @returns {{ status: 'ok', baseline: number, rows: object[] }
 *          | { status: string, detail: string }}
 */
export function parseBaselineLedger(block, decisionIds) {
  /** @type {{ decisionId: string, trigger: string, from: number, to: number }[]} */
  const rows = [];
  for (const line of block.split('\n')) {
    const cells = tableRowCells(line);
    if (!cells || isSeparatorRow(cells)) continue;
    if (cells[0] === 'decision_id') continue; // header row
    if (cells.length !== 4) {
      return {
        status: 'baseline-row-malformed',
        detail: `row must have exactly 4 cells (decision_id | trigger | baseline_from | baseline_to), got ${cells.length}: ${line.trim()}`,
      };
    }
    const [decisionId, trigger, from, to] = cells;
    if (!DECISION_ID_RE.test(decisionId)) {
      return { status: 'baseline-row-malformed', detail: `decision_id must match D<n>: ${line.trim()}` };
    }
    if (!VALID_TRIGGERS.includes(trigger)) {
      return {
        status: 'baseline-row-malformed',
        detail: `trigger must be one of ${VALID_TRIGGERS.join(' | ')}: ${line.trim()}`,
      };
    }
    if (!NON_NEGATIVE_INT_RE.test(from) || !NON_NEGATIVE_INT_RE.test(to)) {
      return {
        status: 'baseline-row-malformed',
        detail: `baseline_from and baseline_to must be non-negative integers: ${line.trim()}`,
      };
    }
    rows.push({ decisionId, trigger, from: Number(from), to: Number(to) });
  }

  if (rows.length === 0) {
    return { status: 'baseline-ledger-empty', detail: `${BASELINE_LEDGER_HEADING} has no data rows` };
  }

  const seenIds = new Set();
  for (const row of rows) {
    if (seenIds.has(row.decisionId)) {
      return {
        status: 'duplicate-baseline-decision-id',
        detail: `decision_id ${row.decisionId} appears more than once`,
      };
    }
    seenIds.add(row.decisionId);
  }

  for (const row of rows) {
    if (!decisionIds.has(row.decisionId)) {
      return {
        status: 'baseline-decision-heading-missing',
        detail: `decision_id ${row.decisionId} has no matching "## ${row.decisionId}" decision heading in decisions.md`,
      };
    }
  }

  if (rows[0].trigger !== TRIGGER_INITIAL || rows[0].from !== 0) {
    return {
      status: 'baseline-chain-broken',
      detail: `first row must be trigger=${TRIGGER_INITIAL} with baseline_from 0; got trigger=${rows[0].trigger} baseline_from=${rows[0].from}`,
    };
  }
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i].trigger !== TRIGGER_SCOPE_CHANGE) {
      return {
        status: 'baseline-chain-broken',
        detail: `only the first row may be trigger=${TRIGGER_INITIAL}; row ${i + 1} (${rows[i].decisionId}) has trigger=${rows[i].trigger}`,
      };
    }
    if (rows[i].from !== rows[i - 1].to) {
      return {
        status: 'baseline-chain-broken',
        detail: `row ${i + 1} (${rows[i].decisionId}) baseline_from=${rows[i].from} does not equal the previous baseline_to=${rows[i - 1].to}`,
      };
    }
  }

  return { status: 'ok', baseline: rows[rows.length - 1].to, rows };
}

/**
 * Decision ids that carry a real `## D<n>` / `### D<n>` heading.
 * Input MUST already be neutralised, so a heading shown inside a fenced or
 * commented-out example never counts as a decision.
 * @param {string} neutralisedContent
 * @returns {Set<string>}
 */
export function decisionHeadingIds(neutralisedContent) {
  const ids = new Set();
  for (const line of String(neutralisedContent ?? '').split('\n')) {
    const m = line.match(DECISION_HEADING_RE);
    if (m) ids.add(m[1]);
  }
  return ids;
}

/** @param {string} path */
function readNeutralised(path) {
  return neutraliseInertMarkdown(readFileSync(path, 'utf8'));
}

/**
 * @param {object} opts
 * @param {string} opts.changeFolder
 * @returns {{ pass: boolean, violations: Array<{reason: string, file?: string, detail?: string}>,
 *            counts?: {baseline: number, current: number, delta: number}, noop?: string, error?: string }}
 */
/**
 * Run a Git command in `cwd` and return its stdout.
 * Injectable so unit tests can drive the resolver without a real repository.
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string}
 */
function defaultGit(args, cwd) {
  return execGitFileSyncWithRetry(
    args,
    {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    },
    { retries: 2, delayMs: 25 },
  );
}

/**
 * Repo-relative pathspecs under which this change's `decisions.md` may have
 * been committed.
 *
 * Archiving renames the folder, so anchoring on the current path alone would
 * report "no prior state" during exactly the window a pre-merge re-archive
 * reopens a change — the window in which an edit is least likely to be noticed.
 *
 * @param {string} repoRoot absolute repo root
 * @param {string} changeFolder absolute change folder
 * @returns {string[]}
 */
export function decisionsPathspecs(repoRoot, changeFolder) {
  const rel = relative(repoRoot, join(changeFolder, 'decisions.md')).split(sep).join('/');
  const specs = [rel];
  const active = rel.match(/^openspec\/changes\/([^/]+)\/decisions\.md$/u);
  const archived = rel.match(/^openspec\/changes\/archive\/\d{4}-\d{2}-\d{2}-(.+)\/decisions\.md$/u);
  const changeId = archived ? archived[1] : active ? active[1] : null;
  if (changeId) {
    for (const candidate of [
      `openspec/changes/${changeId}/decisions.md`,
      `:(glob)openspec/changes/archive/*-${changeId}/decisions.md`,
    ]) {
      if (!specs.includes(candidate)) specs.push(candidate);
    }
  }
  return specs;
}

/**
 * The trusted prior state the append-only check anchors to: the LATEST ledger
 * in the chain-verified sequence of every valid baseline ledger this branch
 * committed since `baseRef`.
 *
 * Anchoring on the earliest one instead protects only the rows that ledger
 * held. A reviewer reproduced the consequence: commit A declares D1, commit B
 * validly appends D2, and a later state then edits or deletes D2 while keeping
 * D1 — the result still extends A, so it passed, and every row appended after
 * the first snapshot was unprotected. So each committed snapshot is verified
 * to extend its predecessor (a break there is a row already committed and then
 * rewritten, reported as such) and the last one becomes the anchor.
 *
 * A work-in-progress ledger in an early commit is still skipped rather than
 * treated as an unusable anchor, which keeps the check from failing closed on
 * ordinary authoring order. Skipping a commit is sound here: its content never
 * enters the sequence, so no row it might have held is ever asserted immutable.
 *
 * Skipping is bounded, though. `absent` means "this branch has not declared a
 * baseline yet" — a first declaration, or an archive rename that moved the file
 * out of the pathspec — and it switches the append-only check off entirely.
 * Reaching the end having *seen* a ledger we could not read is a different
 * fact, and returning `absent` for it would let an unreadable committed ledger
 * buy the same silence a real absence gets. That case returns `unavailable`,
 * which the caller already fails closed on.
 *
 * @param {object} opts
 * @param {string} opts.changeFolder absolute change folder
 * @param {string} opts.baseRef immutable change-base Git ref
 * @param {(args: string[], cwd: string) => string} [opts.git]
 * @returns {{ status: 'found', rows: object[], sha: string, path: string }
 *          | { status: 'history-not-append-only', detail: string }
 *          | { status: 'absent' }
 *          | { status: 'unavailable', detail: string }}
 */
export function resolvePriorBaselineRows({ changeFolder, baseRef, git = defaultGit }) {
  let repoRoot;
  try {
    repoRoot = git(['rev-parse', '--show-toplevel'], changeFolder).trim();
  } catch (err) {
    return { status: 'unavailable', detail: `not inside a Git work tree: ${changeFolder} (${err.message})` };
  }
  // Git reports the real path, so a symlinked prefix anywhere above the repo
  // (macOS `/tmp` -> `/private/tmp` is the everyday one) would otherwise make
  // the relative path climb out of the repository and every pathspec invalid.
  let realChangeFolder;
  try {
    realChangeFolder = realpathSync(changeFolder);
  } catch (err) {
    return { status: 'unavailable', detail: `unable to resolve change folder: ${changeFolder} (${err.message})` };
  }
  try {
    git(['rev-parse', '--verify', `${baseRef}^{commit}`], repoRoot);
  } catch {
    return { status: 'unavailable', detail: `invalid change base ref: ${baseRef}` };
  }

  const pathspecs = decisionsPathspecs(repoRoot, realChangeFolder);
  let log;
  try {
    log = git(
      ['log', '--format=%x00%H', '--name-only', '--reverse', `${baseRef}..HEAD`, '--', ...pathspecs],
      repoRoot,
    );
  } catch (err) {
    return {
      status: 'unavailable',
      detail: `unable to enumerate commits since ${baseRef}: ${err.message}`,
    };
  }

  /** @type {{ sha: string, path: string, why: string }[]} */
  const unreadable = [];
  /** @type {{ rows: object[], sha: string, path: string } | null} */
  let latest = null;

  for (const record of log.split('\0')) {
    const lines = record.split('\n').map((l) => l.trim()).filter(Boolean);
    const sha = lines.shift();
    if (!sha) continue;

    // Readability is a property of the COMMIT, not of a path. A rename shows up
    // as two paths in one record; if either side parses, this commit is
    // readable and the other side is just the rename's counterpart.
    /** @type {{ rows: object[], path: string }[]} */
    const snapshotsHere = [];
    /** @type {{ sha: string, path: string, why: string }[]} */
    const hiddenHere = [];

    // Which of this commit's paths are in its tree. `git log --name-only` also
    // lists what the commit deleted and the pre-rename side of what it moved,
    // and `git show <sha>:<path>` fails identically for "not in this tree" and
    // for an object or I/O failure. Only the tree listing separates them, and
    // that difference is the whole distance between skipping a path and
    // refusing to anchor.
    let present;
    try {
      present = new Set(
        git(['ls-tree', '-r', '--name-only', '-z', sha, '--', ...lines], repoRoot)
          .split('\0')
          .filter(Boolean),
      );
    } catch (err) {
      return {
        status: 'unavailable',
        detail: `unable to list the tree of ${sha.slice(0, 12)}: ${err.message}`,
      };
    }

    for (const path of lines) {
      if (!present.has(path)) continue; // deleted here, or the pre-rename side
      let content;
      try {
        content = git(['show', `${sha}:${path}`], repoRoot);
      } catch (err) {
        // In the tree and still unreadable: an object or I/O failure, never an
        // absence. Absence was already excluded above.
        hiddenHere.push({ sha, path, why: `git could not read it (${err.message})` });
        continue;
      }
      const neutralised = neutraliseInertMarkdown(content);
      const blocks = exactH2Blocks(neutralised, BASELINE_LEDGER_HEADING);
      if (blocks.count !== 1) {
        // Only silence a skip when the raw text has no ledger here either. When
        // it has one this lint cannot see, "not an anchor" describes our
        // reading, not the file.
        if (exactH2Blocks(normaliseLineEndings(content), BASELINE_LEDGER_HEADING).count > 0) {
          hiddenHere.push({
            sha,
            path,
            why:
              blocks.count === 0
                ? 'the heading is there in the raw text but neutralisation removed it, so it sits ' +
                  'inside a code fence, an HTML comment, or an inline code span holding a comment opener'
                : `${blocks.count} live ledger headings, so no single one is authoritative`,
          });
        }
        continue;
      }
      const parsed = parseBaselineLedger(blocks.bodies[0], decisionHeadingIds(neutralised));
      if (parsed.status !== 'ok') {
        hiddenHere.push({ sha, path, why: `the ledger did not parse (${parsed.status})` });
        continue;
      }
      snapshotsHere.push({ rows: parsed.rows, path });
    }

    // Two copies of one ledger reachable at two paths are one answer. Two that
    // disagree are two answers, and taking whichever the path order reached
    // first picks one of them at random — the other copy's rows would never be
    // held immutable, and nothing would record that they had been dropped.
    if (snapshotsHere.length > 1) {
      const first = snapshotsHere[0];
      const key = (rows) => JSON.stringify(rows);
      const disagreeing = snapshotsHere.find((other) => key(other.rows) !== key(first.rows));
      if (disagreeing) {
        return {
          status: 'unavailable',
          detail:
            `${first.path} and ${disagreeing.path} at ${sha.slice(0, 12)} both carry a ` +
            `${BASELINE_LEDGER_HEADING}, and they do not agree. Whichever this lint happened ` +
            "to read first would become the anchor, so the other copy's rows would never be " +
            'held immutable. Refusing to anchor: make the copies agree, or stop one of them ' +
            `from matching the exact '${BASELINE_LEDGER_HEADING}' heading line.`,
        };
      }
    }

    // An unreadable path is tolerable only where nothing depends on it: a
    // commit that contributes no snapshot at all, before any snapshot has been
    // taken. The moment this commit also yields a readable copy, that copy
    // becomes the answer for the whole commit — and the sibling this lint
    // could not read may hold rows the answer omits, which is exactly the
    // bypass, reached through path selection rather than through ordering.
    if (hiddenHere.length > 0 && (latest !== null || snapshotsHere.length > 0)) {
      const first = hiddenHere[0];
      const because =
        snapshotsHere.length > 0
          ? `the same commit also carries a readable one (${snapshotsHere[0].path}), and ` +
            'anchoring on that copy alone would drop whatever rows this one holds'
          : `it was committed AFTER the last readable one (${latest.path} at ` +
            `${latest.sha.slice(0, 12)}), so anchoring there would drop whatever rows it added`;
      return {
        status: 'unavailable',
        detail:
          `${first.path} at ${first.sha.slice(0, 12)} carries a ${BASELINE_LEDGER_HEADING} this ` +
          `lint could not read: ${first.why}. Because ${because}, and those rows are already ` +
          'committed, a later edit or deletion of them would read as an ordinary extension. ' +
          'That is the same violation the sequence check exists to catch. Refusing to anchor: ' +
          'commit a readable ledger on this branch, or stop the unreadable copy from matching ' +
          `the exact '${BASELINE_LEDGER_HEADING}' heading line.`,
      };
    }

    if (snapshotsHere.length === 0) {
      if (hiddenHere.length === 0) continue; // nothing claiming to be a ledger here
      // A commit that carries a ledger none of whose paths this lint could read,
      // before any snapshot has been taken. This costs nothing: no row is
      // asserted immutable yet, so an early draft is skipped exactly as a
      // work-in-progress ledger is. Every case where it is NOT free was
      // already returned above.
      unreadable.push(...hiddenHere);
      continue;
    }

    const snapshot = snapshotsHere[0];

    // A snapshot in the committed sequence. Every one of them must extend
    // its predecessor, or a row this branch already committed was edited or
    // removed by a later commit — the same violation as an uncommitted
    // rewrite, just already in history.
    if (latest !== null) {
      const broke = firstAppendOnlyBreak(latest.rows, snapshot.rows);
      if (broke) {
        return {
          status: 'history-not-append-only',
          detail:
            `${broke} — between ${latest.path} at ${latest.sha.slice(0, 12)} and ` +
            `${snapshot.path} at ${sha.slice(0, 12)}, both already committed on this branch`,
        };
      }
    }
    latest = { rows: snapshot.rows, sha, path: snapshot.path };
  }
  if (latest !== null) return { status: 'found', rows: latest.rows, sha: latest.sha, path: latest.path };
  if (unreadable.length > 0) {
    const first = unreadable[0];
    return {
      status: 'unavailable',
      detail:
        `no readable ${BASELINE_LEDGER_HEADING} anchor since ${baseRef}, yet ${first.path} at ` +
        `${first.sha.slice(0, 12)} carries one this lint could not read: ${first.why}. ` +
        'Refusing to record the anchor as absent: that is the answer reserved for a branch that ' +
        'has not declared a baseline, and it switches the append-only check off entirely. Commit ' +
        'a readable ledger on this branch, or stop the unreadable copy from matching the exact ' +
        `'${BASELINE_LEDGER_HEADING}' heading line.`,
    };
  }
  return { status: 'absent' };
}

/**
 * First way `currentRows` fails to be an append-only extension of
 * `priorRows`, or null when it is one.
 * @param {object[]} priorRows
 * @param {object[]} currentRows
 * @returns {string | null}
 */
export function firstAppendOnlyBreak(priorRows, currentRows) {
  const show = (r) => `${r.decisionId} | ${r.trigger} | ${r.from} | ${r.to}`;
  for (let i = 0; i < priorRows.length; i += 1) {
    const was = priorRows[i];
    const now = currentRows[i];
    if (!now) {
      return (
        `row ${i + 1} \`${show(was)}\` was already committed on this branch and has been removed; ` +
        'baseline rows are append-only'
      );
    }
    if (
      now.decisionId !== was.decisionId ||
      now.trigger !== was.trigger ||
      now.from !== was.from ||
      now.to !== was.to
    ) {
      return (
        `row ${i + 1} was already committed on this branch as \`${show(was)}\` but now reads ` +
        `\`${show(now)}\`; raise the baseline by APPENDING a row naming the decision that ` +
        'raised it, never by editing a row that already stands'
      );
    }
  }
  return null;
}

export function lintRequirementCountRatchet({ changeFolder, baseRef, git }) {
  if (!changeFolder || typeof changeFolder !== 'string') {
    return { pass: false, violations: [], error: 'changeFolder is required' };
  }
  const resolved = resolve(changeFolder);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    return { pass: false, violations: [], error: `change folder not found: ${resolved}` };
  }

  // null / undefined = no base supplied (count-only mode). Anything else must be a
  // resolvable ref: an empty or non-string value is a supplied-but-unusable anchor and
  // fails closed. Past this check a supplied base is a non-empty string, so the later
  // `if (baseRef)` means "base supplied".
  if (baseRef !== undefined && baseRef !== null && (typeof baseRef !== 'string' || baseRef === '')) {
    return {
      pass: false,
      violations: [],
      error: `invalid change base ref: ${JSON.stringify(baseRef)}`,
      priorState: 'unavailable',
    };
  }

  let ledger;
  try { ledger = readRequirementLedger(resolved); }
  catch (err) { return { pass: false, violations: [], error: `failed to read proposal carrier: ${err.message}` }; }
  if (ledger.status === 'no-proposal-carrier' || ledger.status === 'no-requirement-ledger') {
    return { pass: true, violations: [], noop: ledger.status };
  }
  if (ledger.status !== 'ok') {
    return {
      pass: false,
      violations: (ledger.status === 'requirement-ledger-inert-only' ? ledger.files : [ledger.file ?? ledger.files?.join(', ')]).map(file => ({
        reason: ledger.status,
        file,
        detail: ledger.status === 'requirement-ledger-inert-only'
          ? 'Requirement Ledger is visible only inside a code fence, HTML comment, or an inline code span holding a comment opener; restore one live formal Ledger'
          : ledger.malformed
          ? `row \`${ledger.malformed}\` opens with \`|\` but has no closing \`|\`; restore a complete formal Ledger table row`
          : ledger.duplicate
            ? `${ledger.duplicate} appears more than once; the requirement count is ambiguous`
            : `${REQUIREMENT_LEDGER_HEADING}: ${ledger.status}; keep one live formal Ledger with an ID / Disposition table`,
      })),
    };
  }
  const carrier = { name: ledger.file };
  const current = ledger.ids.length;

  const decisionsPath = join(resolved, 'decisions.md');
  if (!existsSync(decisionsPath)) {
    return {
      pass: false,
      violations: [
        {
          reason: 'baseline-ledger-missing',
          detail:
            `${carrier.name} declares ${current} requirement(s) under ${REQUIREMENT_LEDGER_HEADING}, ` +
            `so decisions.md must exist and carry a ${BASELINE_LEDGER_HEADING} naming the baseline`,
        },
      ],
    };
  }

  let decisionsContent;
  try {
    decisionsContent = readNeutralised(decisionsPath);
  } catch (err) {
    return { pass: false, violations: [], error: `failed to read decisions.md: ${err.message}` };
  }

  const baselineBlocks = exactH2Blocks(decisionsContent, BASELINE_LEDGER_HEADING);
  if (baselineBlocks.count === 0) {
    return {
      pass: false,
      violations: [
        {
          reason: 'baseline-ledger-missing',
          file: 'decisions.md',
          detail:
            `${carrier.name} declares ${current} requirement(s), so decisions.md must carry a ` +
            `${BASELINE_LEDGER_HEADING} table naming the baseline (an example inside a code fence ` +
            'or an HTML comment does not count as a declaration)',
        },
      ],
    };
  }
  if (baselineBlocks.count > 1) {
    return {
      pass: false,
      violations: [
        {
          reason: 'duplicate-baseline-ledger',
          file: 'decisions.md',
          detail: `${BASELINE_LEDGER_HEADING} appears ${baselineBlocks.count} times; exactly one is allowed`,
        },
      ],
    };
  }

  const parsed = parseBaselineLedger(baselineBlocks.bodies[0], decisionHeadingIds(decisionsContent));
  if (parsed.status !== 'ok') {
    return {
      pass: false,
      violations: [{ reason: parsed.status, file: 'decisions.md', detail: parsed.detail }],
    };
  }

  // Append-only comes before the count comparison on purpose: an in-place
  // edit of an existing row leaves the chain internally consistent and the
  // counts matching, so a count-first order would report pass and never reach
  // here. Only a prior committed state can see it.
  let priorState = 'not-requested';
  if (baseRef) {
    const prior = resolvePriorBaselineRows({ changeFolder: resolved, baseRef, git });
    if (prior.status === 'unavailable') {
      return { pass: false, violations: [], error: prior.detail, priorState: 'unavailable' };
    }
    priorState = prior.status;
    if (prior.status === 'history-not-append-only') {
      return {
        pass: false,
        violations: [
          {
            reason: 'baseline-ledger-not-append-only',
            file: 'decisions.md',
            detail: prior.detail,
          },
        ],
        counts: { baseline: parsed.baseline, current, delta: current - parsed.baseline },
        priorState,
      };
    }
    if (prior.status === 'found') {
      const broke = firstAppendOnlyBreak(prior.rows, parsed.rows);
      if (broke) {
        return {
          pass: false,
          violations: [
            {
              reason: 'baseline-ledger-not-append-only',
              file: 'decisions.md',
              detail: `${broke} (prior state: ${prior.path} at ${prior.sha.slice(0, 12)})`,
            },
          ],
          counts: { baseline: parsed.baseline, current, delta: current - parsed.baseline },
          priorState,
        };
      }
    }
  }

  const baseline = parsed.baseline;
  const delta = current - baseline;
  if (delta > 0) {
    return {
      pass: false,
      violations: [
        {
          reason: 'requirement-count-exceeds-baseline',
          file: carrier.name,
          detail:
            `baseline=${baseline} current=${current} delta=+${delta} — ` +
            `the Requirement Ledger grew past its declared baseline. Either drop the added ` +
            `requirements, or append one row to ${BASELINE_LEDGER_HEADING} in decisions.md ` +
            `naming the decision that raised it.`,
        },
      ],
      counts: { baseline, current, delta },
      priorState,
    };
  }

  return { pass: true, violations: [], counts: { baseline, current, delta }, priorState };
}

function printViolations(result) {
  if (result.error) {
    if (result.priorState === 'unavailable') {
      process.stderr.write(
        `[lint-requirement-count-ratchet] unavailable: ${result.error}\n`,
      );
      process.stderr.write(
        '\nGit probe unavailable (not an OpenSpec content defect). Re-run the lint/gate; ' +
          'persistent failure is an environment/git-pressure problem, not an active-tree edit.\n',
      );
      return;
    }
    process.stderr.write(`[lint-requirement-count-ratchet] ${result.error}\n`);
    return;
  }
  for (const v of result.violations) {
    const loc = v.file ? v.file : 'change folder';
    process.stderr.write(
      `[lint-requirement-count-ratchet] ${loc}: ${v.reason}${v.detail ? ` — ${v.detail}` : ''}\n`,
    );
  }
  process.stderr.write(
    `\nFix: the ratchet only clears through a structured row in decisions.md:\n\n` +
      `${BASELINE_LEDGER_HEADING}\n\n` +
      '| decision_id | trigger | baseline_from | baseline_to |\n' +
      '|---|---|---|---|\n' +
      `| D1 | ${TRIGGER_INITIAL} | 0 | 5 |\n` +
      `| D7 | ${TRIGGER_SCOPE_CHANGE} | 5 | 9 |\n\n` +
      'Every decision_id must have a real "## D<n>" heading in the same file, ids must be\n' +
      'unique, the first row must start from 0, and each baseline_from must equal the\n' +
      'previous baseline_to. Prose mentioning the trigger name does not clear the ratchet,\n' +
      'and neither does a table shown inside a code fence or an HTML comment.\n\n' +
      'Rows already committed on this branch are append-only: raise the baseline by adding\n' +
      'a row, never by editing one that already stands. Pass --base <change-base-ref> to\n' +
      'have that verified against Git; the origin row itself has no earlier state to be\n' +
      'checked against and stays author-asserted.\n',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runChangeFolderLinterCli({
    scriptName: 'lint-requirement-count-ratchet',
    usage:
      'Usage: node .devpro/scripts/lint-requirement-count-ratchet.mjs <change-folder> [--base <change-base-ref>]\n' +
      '  <change-folder>  path to openspec/changes/<name> (or archive/…)\n' +
      '  --base           immutable Git ref captured when the change branch was created.\n' +
      '                   Without it the baseline is only checked for internal\n' +
      '                   consistency; with it, transitions from an already-committed\n' +
      '                   baseline are additionally verified append-only.',
    parseExtraArgs(argv) {
      let baseRef;
      for (let index = 3; index < argv.length; index += 1) {
        if (argv[index] === '--base' && index + 1 < argv.length) {
          baseRef = argv[++index];
          continue;
        }
        console.error(`[lint-requirement-count-ratchet] unknown or incomplete argument: ${argv[index]}`);
        process.exit(1);
      }
      return { baseRef };
    },
    requireExists: false,
    lint: ({ changeFolder, baseRef }) => lintRequirementCountRatchet({ changeFolder, baseRef }),
    onError(result) {
      printViolations(result);
    },
    printViolation(result) {
      printViolations(result);
    },
    onPass(result, { changeFolder }) {
      if (result.noop) {
        console.log(`[lint-requirement-count-ratchet] ${changeFolder}: pass (no-op: ${result.noop})`);
        return;
      }
      const c = result.counts;
      console.log(
        `[lint-requirement-count-ratchet] ${changeFolder}: pass (baseline=${c.baseline} current=${c.current})`,
      );
    },
  });
}
