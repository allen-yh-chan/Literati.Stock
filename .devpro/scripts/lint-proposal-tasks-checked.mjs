#!/usr/bin/env node
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveExecutableTaskLedgerCarrier } from './lib/task-ledger-resolution.mjs';
import { REQUIREMENT_ID_BODY } from './lib/requirement-ledger-rows.mjs';
import { PROPOSAL_CARRIERS } from './lib/proposal-carriers.mjs';
import { readRequirementLedger } from './lib/requirement-ledger.mjs';
import {
  collectCoverageLedgerRows,
  compareRequirementTaskCoverage,
} from './lib/requirement-task-coverage.mjs';
import { runChangeFolderLinterCli } from './lib/openspec-linter-cli.mjs';

/**
 * Pre-archive lint: verify an active OpenSpec change folder's task checklist is
 * a real execution ledger, not a decorative one.
 *
 * Enforces the "checkbox = execution state, not after-the-fact decoration"
 * contract from `openspec-quality-and-formats.md` §Tasks.md 品質要求 執行迴路:
 *   (1) a full change has exactly one executable task ledger: `tasks.md`;
 *       `proposal.md` may carry only non-executable pointer/scope/defer text in
 *       its canonical Tasks and explicit Deferred sections, never a top-level
 *       task checkbox;
 *   (2) every top-level task checkbox is checked `[x]` (or the change explicitly
 *       declares a `## Deferred` section authorizing unchecked tasks); and
 *   (3) every `[x]` task carries a STRUCTURAL evidence anchor — a `[Req: R#]`
 *       ledger tag AND a 驗收/acceptance line inside the task block — so an empty
 *       check-off (a bare `[x]` with no evidence) cannot fake completion.
 *
 * This is the mechanical closing-layer backstop for the execution-loop clause.
 * It runs BEFORE `openspec archive` (joined into /devpro:pre-pr Step 3.6 pre-archive
 * lints), reading the ACTIVE change folder (`openspec/changes/<name>/` only).
 * MUST NOT be pointed at `openspec/changes/archive/...`: archived `tasks.md`
 * commonly uses H1 `# Tasks: <change-name>`, which this lint does not treat as
 * a canonical Tasks heading (`noncanonical-heading-with-checkbox`).
 * `pre-pr-archive-gate.mjs`'s post-archive check is the terminal backstop
 * reading `archive/<name>/`.
 *
 * Scope: executable carrier selected via `lib/task-ledger-resolution.mjs`
 * (ordered `proposal-mini.md` then `tasks.md`). When full `tasks.md` and
 * `proposal.md` coexist, it also checks the proposal's canonical Tasks section
 * and explicit Deferred sections for top-level duplicate task rows. A chore-A
 * change with neither ledger file, or a change with no task-bearing section
 * AND no top-level task checkbox anywhere in the carrier, is a graceful pass.
 * A carrier with a top-level task checkbox but no canonical Tasks heading is
 * ledger evidence found under a non-canonical heading — that is a hard failure
 * (`noncanonical-heading-with-checkbox`), not a graceful pass; see the
 * `tasksBody === null` branch below.
 */

/**
 * Canonical Tasks heading prefix, shared by `extractTasksSection` (which needs
 * the trailing body-capture group appended) and `detectNearMissTasksHeading`
 * (which only needs the heading-line test). Matches plain `## Tasks` AND the
 * the `proposal-template.md` template-form `## Section N: Tasks` / `## N.
 * Tasks` — both are canonical, not a typo (see decisions.md D2). The trailing
 * parenthesized annotation accepts either half-width `(...)` or full-width
 * `（...）` parentheses (e.g. `## Tasks（含委派計畫）`) — both are the same
 * canonical shape, just a different annotation script (T1/T2, R2).
 */
const CANONICAL_TASKS_HEADING_RE = /^##\s+(?:Section\s+\d+:\s+|\d+\.\s+)?Tasks[ \t]*(?:[(（][^)）\n]*[)）][ \t]*)?$/;

/**
 * A top-level (non-indented) task checkbox bullet, the same shape `splitTaskBlocks`
 * treats as a task. Used, independent of any heading match, as the ledger-evidence
 * predicate for the `tasksBody === null` branch below (D1: P2 — "top-level checkbox
 * exists" — chosen over "near-miss heading found", so this MUST NOT be gated on
 * `detectNearMissTasksHeading()`'s result; see decisions.md D1).
 */
const TOP_LEVEL_CHECKBOX_RE = /^- \[( |x|X)\]/m;

/**
 * Extract the body of the Tasks section (up to the next `## ` heading or EOF).
 * @param {string} content
 * @returns {string|null} the section body, or null if no canonical Tasks heading
 */
export function extractTasksSection(content) {
  const norm = content.replace(/\r\n/g, '\n');
  // Match the canonical Tasks heading (plain `## Tasks` or template-form
  // `## Section N: Tasks` / `## N. Tasks`), allowing only an optional
  // parenthesized count on the heading line (e.g. "## Tasks (6)").
  const re = new RegExp(CANONICAL_TASKS_HEADING_RE.source + '\\n([\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))', 'gm');
  const m = re.exec(norm);
  return m ? m[1] : null;
}

/**
 * Detect a "near-miss" Tasks heading: a markdown heading line that mentions
 * "tasks" (plural, word-boundary) but is NOT the canonical Tasks heading
 * matched by `extractTasksSection` (e.g. `### Tasks` or `## Sub Tasks`). Its
 * result only labels which non-canonical heading (if any) was found; it does
 * not itself decide pass/fail. Whether that non-canonical heading is a mere
 * advisory WARNING or a hard failure now depends on whether the carrier also
 * has a top-level task checkbox (`TOP_LEVEL_CHECKBOX_RE`) — checkbox present
 * → `noncanonical-heading-with-checkbox` violation; checkbox absent → WARNING
 * only, so a silently-skipped Tasks section without any ledger evidence is
 * still visible instead of silent (see the `tasksBody === null` branch below).
 *
 * Canonical headings — plain `## Tasks` / `## Tasks (6)` AND template-form
 * `## Section N: Tasks` / `## N. Tasks` (per `proposal-template.md` §Section 3: Tasks) — are
 * deliberately excluded (they are not a near-miss — they ARE the real thing,
 * and are now genuinely checked by `extractTasksSection`; see decisions.md D2).
 *
 * @param {string} content
 * @returns {string|null} the first near-miss heading line found, or null
 */
export function detectNearMissTasksHeading(content) {
  const norm = content.replace(/\r\n/g, '\n');
  const lines = norm.split('\n');
  const headingRe = /^#{1,6}\s/;
  const tasksWordRe = /\btasks\b/i;
  for (const line of lines) {
    if (!headingRe.test(line)) continue;
    if (CANONICAL_TASKS_HEADING_RE.test(line)) continue; // canonical — not a near-miss
    if (tasksWordRe.test(line)) return line;
  }
  return null;
}

/**
 * Detect whether the change declares a `## Deferred` section (escape-hatch that
 * authorizes unchecked tasks — mirrors the `## Removed Scenarios` escape-hatch
 * in lint-modified-scenario-preservation.mjs).
 * @param {string} content
 * @returns {boolean}
 */
export function hasDeferredSection(content) {
  const norm = content.replace(/\r\n/g, '\n');
  return /^##\s+Deferred\b/m.test(norm);
}

/**
 * Extract every explicit top-level `## Deferred` section body. Deferred remains
 * an escape hatch for unchecked tasks in the canonical executable ledger, but
 * it cannot become a second proposal ledger for a full change.
 *
 * @param {string} content
 * @returns {string[]}
 */
export function extractDeferredSections(content) {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const bodies = [];
  let current = null;

  for (const line of lines) {
    if (/^##\s+Deferred\b/.test(line)) {
      if (current !== null) bodies.push(current.join('\n'));
      current = [];
    } else if (current !== null && /^##\s+/.test(line)) {
      bodies.push(current.join('\n'));
      current = null;
    } else if (current !== null) {
      current.push(line);
    }
  }
  if (current !== null) bodies.push(current.join('\n'));
  return bodies;
}

const LEDGER_OWNER_COLUMN = 'Owner / Next Step';

/**
 * Whether `body` names the exact Requirement Ledger ID as a whole token, so `R1`
 * is not satisfied by `R10` or `XR1`.
 *
 * @param {string} body
 * @param {string} id
 * @returns {boolean}
 */
function namesLedgerId(body, id) {
  const escaped = String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^A-Za-z0-9])${escaped}(?![A-Za-z0-9])`).test(body);
}

/**
 * Find top-level unchecked `- [ ]` rows outside the canonical Tasks section body
 * and outside every explicit `## Deferred` section body (issue #1893 sibling
 * escape hatch). Does NOT widen `extractTasksSection` truncation.
 *
 * @param {string} content
 * @returns {Array<{lineNo: number, headingLine: string, label: string}>}
 */
export function findSiblingUncheckedOutsideTasks(content) {
  const norm = content.replace(/\r\n/g, '\n');
  const lines = norm.split('\n');
  const excluded = new Set();

  // Exclude canonical Tasks section body (same start/end as extractTasksSection).
  for (let i = 0; i < lines.length; i++) {
    if (!CANONICAL_TASKS_HEADING_RE.test(lines[i])) continue;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^##\s/.test(lines[j])) break;
      excluded.add(j);
    }
    break; // first canonical Tasks heading only (mirrors extractTasksSection)
  }

  // Exclude every ## Deferred section body (heading itself is not body).
  let inDeferred = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Deferred\b/.test(lines[i])) {
      inDeferred = true;
      continue;
    }
    if (inDeferred && /^##\s/.test(lines[i])) {
      inDeferred = /^##\s+Deferred\b/.test(lines[i]);
      continue;
    }
    if (inDeferred) excluded.add(i);
  }

  const hits = [];
  const uncheckedRe = /^- \[ \](.*)$/;
  for (let i = 0; i < lines.length; i++) {
    if (excluded.has(i)) continue;
    const m = uncheckedRe.exec(lines[i]);
    if (!m) continue;
    hits.push({
      lineNo: i + 1,
      headingLine: lines[i],
      label: m[1].trim().slice(0, 80),
    });
  }
  return hits;
}

/**
 * Split a Tasks-section body into per-task blocks. A "task" is a TOP-LEVEL
 * (non-indented) checkbox bullet `- [ ]` / `- [x]`. Its block includes all
 * following lines (indented sub-bullets, blank lines) until the next top-level
 * checkbox bullet or EOF. Indented checkboxes (sub-items) are NOT tasks and are
 * folded into the enclosing block.
 *
 * @param {string} tasksBody
 * @returns {Array<{checked: boolean, headingLine: string, block: string, lineNo: number}>}
 */
export function splitTaskBlocks(tasksBody) {
  const lines = tasksBody.split('\n');
  // Top-level checkbox: line starts with "- [ ]" or "- [x]" (no leading whitespace).
  const topRe = /^- \[( |x|X)\]\s?(.*)$/;
  const tasks = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = topRe.exec(line);
    if (m) {
      if (cur) tasks.push(cur);
      cur = {
        checked: m[1].toLowerCase() === 'x',
        headingLine: line,
        block: line,
        lineNo: i + 1,
      };
    } else if (cur) {
      cur.block += '\n' + line;
    }
    // lines before the first top-level checkbox (e.g. intro prose) are ignored
  }
  if (cur) tasks.push(cur);
  return tasks;
}

/**
 * Check a single task block for a structural evidence anchor:
 *   - a `[Req: R#]` ledger tag (exact-ID form, per Tasks.md 品質要求), AND
 *   - a 驗收/acceptance line (a line containing 驗收 or "acceptance", case-insensitive).
 * @param {string} block
 * @returns {{hasReq: boolean, hasAcceptance: boolean}}
 */
export function checkEvidenceAnchor(block) {
  // [Req: R1] / [Req: R1, R2] / [Req: R1] [Req: R2] — require at least one id.
  // The id shape comes from lib/requirement-ledger-rows.mjs so this probe cannot
  // drift from the gates that parse the ledger those tags point at.
  const hasReq = new RegExp(`\\[Req:\\s*${REQUIREMENT_ID_BODY}`, 'u').test(block);
  // A 驗收 line (Chinese) or an "acceptance"/"驗收證據" marker (allow ASCII).
  const hasAcceptance = /驗收|acceptance/i.test(block);
  return { hasReq, hasAcceptance };
}

/**
 * Core lint. Returns { pass, violations, checkedFile } where violations is a
 * list of { kind, task, detail }.
 *
 * @param {object} opts
 * @param {string} opts.changeFolder - absolute path to openspec/changes/<name>
 * @returns {{pass: boolean, violations: Array, checkedFile: string|null, error?: string}}
 */
export function lintProposalTasksChecked({ changeFolder }) {
  if (!existsSync(changeFolder) || !statSync(changeFolder).isDirectory()) {
    return { pass: false, violations: [], checkedFile: null, error: `change folder not found: ${changeFolder}` };
  }

  // Executable task-ledger carrier: SSOT ordered-first (proposal-mini.md then
  // tasks.md). See lib/task-ledger-resolution.mjs.
  const resolved = resolveExecutableTaskLedgerCarrier(changeFolder);
  const filePath = resolved ? resolved.absolutePath : null;
  const tasksPath = join(changeFolder, 'tasks.md');
  const proposalPath = join(changeFolder, 'proposal.md');

  if (!filePath) {
    // No task ledger (chore-A style) — nothing to check.
    return { pass: true, violations: [], checkedFile: null };
  }

  let content;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return { pass: true, violations: [], checkedFile: filePath };
  }

  const violations = [];

  // Full-change single-ledger contract: tasks.md is the only executable ledger.
  // B-mini is intentionally unchanged because proposal-mini.md is its inline
  // ledger and takes precedence above. Parse the canonical proposal Tasks
  // section plus explicit Deferred sections, and only top-level checkbox rows,
  // so examples elsewhere do not create false positives. `## Deferred` does not
  // authorize duplication.
  if (filePath === tasksPath && existsSync(proposalPath)) {
    try {
      const proposalContent = readFileSync(proposalPath, 'utf8');
      const proposalTaskBodies = [
        extractTasksSection(proposalContent),
        ...extractDeferredSections(proposalContent),
      ].filter((body) => body !== null);
      for (const body of proposalTaskBodies) {
        for (const task of splitTaskBlocks(body)) {
          const label = task.headingLine.replace(/^- \[.\]\s?/, '').trim().slice(0, 80);
          violations.push({
            kind: 'duplicate-ledger',
            task: label,
            detail: 'proposal.md is not an executable task ledger for a full change; keep or move this task to tasks.md and replace it with a non-executable pointer or summary',
          });
        }
      }
    } catch {
      // Preserve the existing additive/fail-open read-error contract.
    }
  }

  const tasksBody = extractTasksSection(content);
  if (tasksBody === null) {
    // No canonical `## Tasks` section. This used to be an unconditional graceful
    // pass (plus an advisory-only near-miss WARNING). It no longer is: if the
    // carrier nonetheless contains a top-level task checkbox, that checkbox IS
    // ledger evidence — the exact "checkbox = execution state" contract this
    // lint exists to enforce — and the heading being non-canonical (or not even
    // mentioning "tasks" at all — Family C) must not let it slip through
    // (R1/D1). This predicate is deliberately orthogonal to
    // `detectNearMissTasksHeading()`: it fires whether or not a near-miss
    // heading was found, so a Family C carrier (no heading anywhere mentions
    // "tasks", so `detectNearMissTasksHeading()` itself returns null) still
    // gets caught.
    const nearMissHeading = detectNearMissTasksHeading(content);
    if (TOP_LEVEL_CHECKBOX_RE.test(content.replace(/\r\n/g, '\n'))) {
      const headingDetail = nearMissHeading
        ? `nearest non-canonical heading found: "${nearMissHeading}"`
        : 'no heading anywhere mentions "tasks"';
      violations.push({
        kind: 'noncanonical-heading-with-checkbox',
        task: filePath,
        detail:
          `${filePath}: carrier contains a top-level task checkbox (ledger evidence) but no canonical Tasks heading was found (${headingDetail}); ` +
          'canonical shapes are plain `## Tasks` or template-form `## Section N: Tasks` / `## N. Tasks`, each optionally followed by a parenthesized ' +
          'annotation in half-width `(...)` or full-width `（...）` — align the heading with one of these, or move the checkbox out of the carrier',
      });
    }
    // Advisory-only: surface a near-miss heading (a genuinely non-canonical
    // heading such as `### Tasks` / `## Sub Tasks` — NOT the canonical
    // template-form `## Section N: Tasks`, which is now matched and checked; see
    // decisions.md D2) so a silently-skipped section is visible to the caller.
    // This WARNING is independent of, and does not gate, the violation above.
    return {
      pass: violations.length === 0,
      violations,
      checkedFile: filePath,
      nearMissHeading,
    };
  }

  const deferred = hasDeferredSection(content);
  const tasks = splitTaskBlocks(tasksBody);

  for (const t of tasks) {
    const label = t.headingLine.replace(/^- \[.\]\s?/, '').trim().slice(0, 80);
    if (!t.checked) {
      // Unchecked task is a violation UNLESS the change declares `## Deferred`.
      if (!deferred) {
        violations.push({ kind: 'unchecked', task: label, detail: 'task not checked `[x]` and no `## Deferred` section declared' });
      }
      // If deferred, an unchecked task is authorized — skip evidence check for it.
      continue;
    }
    // Checked task MUST carry a structural evidence anchor.
    const { hasReq, hasAcceptance } = checkEvidenceAnchor(t.block);
    if (!hasReq) {
      violations.push({ kind: 'no-req', task: label, detail: 'checked `[x]` but missing `[Req: R#]` ledger anchor' });
    }
    if (!hasAcceptance) {
      violations.push({ kind: 'no-acceptance', task: label, detail: 'checked `[x]` but missing 驗收/acceptance evidence line' });
    }
  }

  // Sibling unchecked scan (#1893): after Tasks-section checks, flag top-level
  // `- [ ]` outside canonical Tasks body and outside every ## Deferred body.
  // Truncation of extractTasksSection is intentionally unchanged.
  for (const hit of findSiblingUncheckedOutsideTasks(content)) {
    violations.push({
      kind: 'sibling-unchecked',
      task: hit.label,
      detail:
        `top-level unchecked \`- [ ]\` outside canonical Tasks / Deferred (line ${hit.lineNo}): ${hit.headingLine}`,
    });
  }

  return { pass: violations.length === 0, violations, checkedFile: filePath };
}

/**
 * Requirement Ledger <-> task coverage, for the CLI layer only.
 *
 * Deliberately NOT part of `lintProposalTasksChecked`: `pre-pr-archive-gate.mjs`
 * check (o) re-runs that exported function AFTER archive, and gate (m) already
 * reports this same violation there. Folding coverage into the exported
 * function would make one defect produce two archive-gate errors. Wiring it at
 * the CLI layer instead gives the pre-archive command (devpro:pre-pr Step 3.0 / 3.6)
 * the check it needs, adds no fifth lint command, and leaves check (o)'s
 * contract untouched (fix-zero-value-review-rounds R7, design.md D9).
 *
 * The verdict itself is NOT computed here — `lib/requirement-task-coverage.mjs`
 * owns it, and gate (m) asks the same module the same question. This function
 * only resolves paths (active change folder, not an archive folder) and phrases
 * the answer as this lint's `{kind, task, detail}` violations.
 *
 * Independent of `lintProposalTasksChecked`'s no-task-ledger early return on
 * purpose: coverage is a question about the PROPOSAL's ledger, and an
 * `implemented` row with no executable task carrier at all is exactly the state
 * that must not pass. Mirroring gate (m), the proposal body itself is then the
 * coverage body.
 *
 * Graceful pass — no proposal carrier, no `## Requirement Ledger` heading, no
 * parseable ledger table — is intentional and bounded: those are ledger-SHAPE
 * faults, and gate (m) owns their diagnostics with its canonical-ledger example.
 * Before taking any of those shape exits, however, every existing carrier this
 * comparison would consume is resolved and read. A carrier read fault is an
 * evidence fault, not a shape verdict, so the CLI returns a blocking violation
 * just as gate (m) fails closed. This check moves the COVERAGE comparison
 * earlier, not the whole ledger schema.
 *
 * @param {object} opts
 * @param {string} opts.changeFolder - absolute path to openspec/changes/<name>
 * @returns {{ violations: Array<{kind: string, task: string, detail: string}> }}
 */
function lintRequirementTaskCoverage({ changeFolder }) {
  const violations = [];

  let ledger;
  try { ledger = readRequirementLedger(changeFolder); }
  catch (err) {
    return { violations: [{ kind: 'coverage-read-error', task: 'proposal carrier', detail: `failed to read Requirement Ledger: ${err.message}` }] };
  }
  const proposalBody = ledger.body;

  const resolved = resolveExecutableTaskLedgerCarrier(changeFolder);
  let taskBody = null;
  let source = 'proposal/proposal-mini Tasks';
  if (resolved) {
    try {
      taskBody = readFileSync(resolved.absolutePath, 'utf8');
      source = resolved.filename;
    } catch {
      return {
        violations: [{
          kind: 'coverage-read-error',
          task: resolved.filename,
          detail: `${resolved.filename} exists but could not be read for Requirement Ledger coverage; fail closed and restore a readable regular carrier`,
        }],
      };
    }
  }

  if (ledger.status === 'no-proposal-carrier' || ledger.status === 'no-requirement-ledger') return { violations };
  if (ledger.status !== 'ok' && ledger.status !== 'requirement-ledger-table-missing') {
    return { violations: [{ kind: ledger.status, task: ledger.file || (ledger.files || []).join(', '), detail: `${ledger.status}: keep one live formal Ledger with complete, unique rows` }] };
  }
  const table = ledger.table;
  if (!table || table.rows.length === 0) return { violations };
  const ledgerRows = collectCoverageLedgerRows(table);
  if (taskBody === null) taskBody = proposalBody;

  const coverage = compareRequirementTaskCoverage({ ledgerRows, taskBody });

  for (const invalidRange of coverage.invalidRanges) {
    violations.push({
      kind: 'req-range-ref',
      task: `[Req: ${invalidRange}]`,
      detail:
        `${source}: a range is never a valid ref; enumerate the exact Requirement Ledger IDs ` +
        '(`[Req: R1] [Req: R2]`, not `[Req: R1-R7]`)',
    });
  }

  for (const taskRef of coverage.unknownRefs) {
    violations.push({
      kind: 'req-unknown-ledger-row',
      task: `[Req: ${taskRef}]`,
      detail:
        `${source}: no Requirement Ledger row carries this ID; use exact IDs from the 6-column ledger table`,
    });
  }

  for (const row of coverage.uncoveredRows) {
    violations.push({
      kind: 'ledger-row-uncovered',
      task: `row ${row.rowNumber} (${row.id})`,
      detail:
        `Requirement Ledger row ${row.rowNumber} (${row.id}) is \`${row.disposition}\` but no task in ` +
        `${source} claims it; add \`[Req: ${row.id}]\` to the task that implements it, or change the row's Disposition`,
    });
  }

  // `partial` is the in-progress Disposition. Once every top-level task is
  // checked it is stale. A row stays `partial` only with its own deferral: a
  // `## Deferred` line that names this exact ID AND a non-empty Owner / Next
  // Step cell on the row. An unrelated or empty Deferred section exempts
  // nothing. With an unchecked task and no Deferred section the unchecked-task
  // violation already fails the lint, so this one stays silent then.
  const tasks = splitTaskBlocks(taskBody);
  const everyTaskChecked = tasks.length > 0 && tasks.every((task) => task.checked);
  if (everyTaskChecked) {
    const deferredBodies = [
      ...extractDeferredSections(proposalBody),
      ...(taskBody === proposalBody ? [] : extractDeferredSections(taskBody)),
    ];
    const ownerIndex = table.header.indexOf(LEDGER_OWNER_COLUMN);
    for (const [index, row] of ledgerRows.entries()) {
      if (row.disposition !== 'partial') continue;
      const named = deferredBodies.some((body) => namesLedgerId(body, row.id));
      const owner = ownerIndex >= 0 ? String(table.rows[index]?.[ownerIndex] ?? '').trim() : '';
      const ownerPresent = owner !== '' && !/^(?:[-–—]+|n\/a|tbd)$/i.test(owner);
      if (named && ownerPresent) continue;
      const missing = [
        ...(named ? [] : [`no \`## Deferred\` line names ${row.id}`]),
        ...(ownerPresent ? [] : [`its \`${LEDGER_OWNER_COLUMN}\` cell is empty`]),
      ].join(' and ');
      violations.push({
        kind: 'ledger-row-partial-after-complete',
        task: `row ${row.rowNumber} (${row.id})`,
        detail:
          `Requirement Ledger row ${row.rowNumber} (${row.id}) is still \`partial\` but every task in ${source} is checked, and ${missing}; ` +
          `set its Disposition to \`implemented\` (or \`deferred\` / \`moved-to-issue\`), or keep \`partial\` with a \`## Deferred\` line naming ${row.id} and a filled \`${LEDGER_OWNER_COLUMN}\` cell`,
      });
    }
  }

  return { violations };
}

// CLI entry
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runChangeFolderLinterCli({
    scriptName: 'lint-proposal-tasks-checked',
    usage:
      'Usage: node lint-proposal-tasks-checked.mjs <change-folder>\n' +
      '  <change-folder>  path to openspec/changes/<name>',
    lint: ({ changeFolder }) => {
      const result = lintProposalTasksChecked({ changeFolder });
      // Folder-level failures remain authoritative before the additive coverage
      // comparison; carrier read failures are emitted by that comparison below.
      if (result.error) return result;
      const coverage = lintRequirementTaskCoverage({ changeFolder });
      if (coverage.violations.length === 0) return result;
      return {
        ...result,
        pass: false,
        violations: [...result.violations, ...coverage.violations],
      };
    },
    printViolation(result) {
      for (const v of result.violations) {
        process.stderr.write(
          `[lint-proposal-tasks-checked] ${v.kind}: "${v.task}" — ${v.detail}\n`
        );
      }
      process.stderr.write(
        '\nFix: this is the closing-layer backstop for the execution-loop clause\n' +
        '(openspec-quality-and-formats.md §Tasks.md 品質要求 執行迴路). Each task MUST be\n' +
        'executed as a 逐條認領→做→當下回勾 loop:\n' +
        '  - duplicate-ledger   → proposal.md is not an executable task ledger for a full change;\n' +
        '                         keep or move the task to tasks.md, then leave only a pointer or summary;\n' +
        '  - unchecked task     → finish it and check `[x]` NOW (not memory-driven later),\n' +
        '                         or declare an authorized `## Deferred` section;\n' +
        '  - `[x]` missing evidence → add its `[Req: R#]` ledger tag and a 驗收: line so the\n' +
        '                         check-off is bound to verifiable evidence (empty check = not done).\n' +
        '  - sibling-unchecked → a top-level `- [ ]` sits outside canonical Tasks (and outside\n' +
        '                         `## Deferred` body); move it into Tasks, finish+check it, or\n' +
        '                         put authorized incomplete work under `## Deferred`.\n' +
        '  - noncanonical-heading-with-checkbox → the carrier has a top-level task checkbox but\n' +
        '                         no canonical Tasks heading; rename the heading to plain `## Tasks`\n' +
        '                         or template-form `## Section N: Tasks` / `## N. Tasks`.\n' +
        '  - ledger-row-uncovered / req-unknown-ledger-row / req-range-ref → the Requirement Ledger\n' +
        '                         and the task ledger disagree. Same verdict pre-pr-archive-gate.mjs\n' +
        '                         gate (m) reports after archive (shared lib/requirement-task-coverage.mjs),\n' +
        '                         reported here BEFORE archive so the fix costs no re-archive cycle.\n' +
        '  - ledger-row-partial-after-complete → every task is checked but a Requirement Ledger row is still\n' +
        '                         `partial`; set it to a terminal Disposition, or keep it with a `## Deferred` line\n' +
        '                         naming that exact ID and a filled `Owner / Next Step` cell on the row.\n' +
        '  - coverage-read-error → an existing proposal/task carrier could not be read; restore a\n' +
        '                         readable regular file before trusting the coverage verdict.\n' +
        '\nThis lint runs BEFORE `openspec archive` on ACTIVE `openspec/changes/<name>/` only;\n' +
        'MUST NOT run against `openspec/changes/archive/...` (archived `# Tasks: <name>` H1 is out of scope).\n' +
        'pre-pr-archive-gate.mjs is the post-archive backstop.\n'
      );
    },
    onPass(result, { changeFolder }) {
      if (result.nearMissHeading) {
        console.log(
          `[lint-proposal-tasks-checked] WARNING: near-miss heading "${result.nearMissHeading}" — ` +
          '疑似 Tasks 段 heading 格式異常，該段被跳過未檢查；若本意是 task ledger，' +
          '請確認 heading 與 proposal-template.md 的 Tasks heading（plain `## Tasks` 或 template-form `## Section N: Tasks`）一致'
        );
      }
      console.log(`[lint-proposal-tasks-checked] ${result.checkedFile ?? changeFolder}: pass`);
    },
  });
}
