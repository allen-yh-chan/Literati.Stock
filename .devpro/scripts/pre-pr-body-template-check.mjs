#!/usr/bin/env node
/**
 * pre-pr-body-template-check.mjs
 *
 * PR body lint script — checks that a PR description draft contains the
 * canonical template phrases defined in:
 *   .devpro/agent-rules/git-pr-template-and-merge.md §PR 描述模板（複製後填入，降低遺漏率）
 *
 * The canonical sections include:
 *   ## OpenSpec / ## Change Context / ## Manual Test / ## Requirement Ledger Completion / ## Test Evidence /
 *   ## Scenario Walkthrough / ## Cost Circuit Breaker Overrides / ## Security Review / ## Conditional Fields
 *
 * Mandatory phrases (absence = fail):
 *   - `## Change Context` (H2 marker required — human-facing 改什麼→目的)
 *   - `## Manual Test` (H2 marker required — how/what/pass or N/A one-liner)
 *   - `## Test Evidence`  (H2 marker required — avoids false positives from
 *                          code block content containing `Test Evidence`)
 *   - `## Scenario Walkthrough` (H2 marker required — keeps enforcement-carrier
 *                                walkthrough status visible in every PR body)
 *   - `## Cost Circuit Breaker Overrides` (H2 marker required — D11 §S-1:
 *                                          keeps override usage visible at
 *                                          PR-review time, not only in the
 *                                          gitignored local checkpoint;
 *                                          when a readable checkpoint exists,
 *                                          also cross-checks content via
 *                                          evaluateOverrideDisclosure SSOT)
 *   - `## Requirement Ledger Completion` (H2 marker required — completion must
 *                                        be reported against ledger disposition;
 *                                        section must contain counts or N/A)
 *   - `驗收證據`           (no marker constraint — appears inside the section)
 *
 * After those checks pass, a second group of checks runs only when the PR will be sent for a second
 * opinion: the evidence sections and the Change Context must not be over their byte limits or carry
 * unfilled template text, because the second-review handoff builder (build-pr-sticky-handoff.mjs)
 * rejects such a body after the PR exists. Rules come from lib/pr-body-evidence-rules.mjs, the same
 * source the builder uses. An exempt PR, or anything that cannot be determined (design D5), is not blocked
 * (fail open); stdout says which. --pr-cwd names the checkout the PR comes from when it is not --cwd
 * (the hook passes it after a leading `cd`): the evidence checks, the rules-lane head and the override disclosure
 * read its branch and directory instead of --branch / --cwd; --pr-head, when given, names the head for the latter two.
 *
 * Usage:
 *   node pre-pr-body-template-check.mjs --body-file <path> [--branch <name>] [--cwd <dir>]
 *                                       [--pr-head <name>] [--pr-base <name>] [--pr-target-unresolved]
 *                                       [--pr-cwd <dir>]
 *   echo "..." | node pre-pr-body-template-check.mjs
 *
 * Exit codes:
 *   0 — all mandatory phrases present (and disclosure ok / skipped); evidence checks passed or skipped
 *   1 — one or more mandatory phrases missing, override disclosure mismatch, or (second review required)
 *       an evidence-section / Change Context finding
 *   2 — body input is empty or unreadable
 */

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { readBodyFromFileArgOrStdin } from './lib/cli-io.mjs';
import { evaluateOverrideDisclosure } from './hooks/lib/post-pr-cost-circuit-breaker.mjs';
import { isRulesLaneSyncPrHead } from './lib/consumer-pre-pr-gate.mjs';

const REFERENCE = '.devpro/agent-rules/git-pr-template-and-merge.md §PR 描述模板（複製後填入，降低遺漏率）';

/**
 * Mandatory phrases and their match patterns.
 * Using exact string match (no regex) for readability; phrase list is small.
 */
const REQUIREMENT_LEDGER_LABEL = '## Requirement Ledger Completion with disposition counts or N/A: <reason>';
const MANDATORY_PHRASES = [
  {
    label: '## Change Context',
    test: (body) => /(?:^|\n)## Change Context\b/.test(body),
  },
  {
    label: '## Manual Test',
    test: (body) => /(?:^|\n)## Manual Test\b/.test(body),
  },
  {
    label: '## Test Evidence',
    // Must appear as an H2 heading line (starts at beginning of line, or after
    // a newline) to avoid matching `Test Evidence` inside code blocks that lack
    // the `## ` marker.
    test: (body) => /(?:^|\n)## Test Evidence/.test(body),
  },
  {
    label: REQUIREMENT_LEDGER_LABEL,
    test: (body) => hasValidRequirementLedgerCompletion(body),
  },
  {
    label: '## Scenario Walkthrough',
    test: (body) => /(?:^|\n)## Scenario Walkthrough/.test(body),
  },
  {
    label: '## Cost Circuit Breaker Overrides',
    test: (body) => /(?:^|\n)## Cost Circuit Breaker Overrides/.test(body),
  },
  {
    label: '驗收證據',
    test: (body) => body.includes('驗收證據'),
  },
];

/** Advisory-only phrases: warn on stderr, do NOT fail the check. */
const ADVISORY_PHRASES = [
  {
    label: '覆蓋：',
    test: (body) => body.includes('覆蓋：'),
  },
];

/**
 * Release Target advisory (single phrase, separate stderr block).
 *
 * The `Release Target: <YYYYMMDD>` line is the human-readable echo of the PR
 * milestone described by release-sit-uat-pat-prod.md §Subset selection
 * handoff. Per the Release Target Human-Readable PR Field requirement it MUST
 * warn when absent and MUST NOT block, so it is emitted as its own advisory
 * block rather than joining the mandatory phrase list.
 */
const RELEASE_TARGET_ADVISORY = {
  label: 'Release Target: <YYYYMMDD>',
  test: (body) => /\bRelease Target\b/.test(body),
};

function extractH2Section(body, heading) {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headingRe = new RegExp(`(?:^|\\n)${escapedHeading}\\b[^\\n]*\\n?`);
  const match = headingRe.exec(body);
  if (!match) return null;
  const start = match.index + match[0].length;
  const rest = body.slice(start);
  const nextHeading = /\n## [^\n]+/.exec(rest);
  return nextHeading ? rest.slice(0, nextHeading.index) : rest;
}

function hasValidRequirementLedgerCompletion(body) {
  const section = extractH2Section(body, '## Requirement Ledger Completion');
  if (!section || !section.trim()) return false;

  const hasDispositionCounts =
    /disposition counts\s*:\s*.*implemented\s+\d+\b.*partial\s+\d+\b.*deferred\s+\d+\b.*rejected\s+\d+\b.*moved-to-issue\s+\d+\b/is.test(section);
  if (hasDispositionCounts) return true;

  return /\bN\/A\s*:\s*(?!\s*(?:<[^>]+>|reason|tbd|todo|none|-)\s*$).{3,}/i.test(section);
}

/**
 * The `## OpenSpec` section, when it carries an `archive:` line, must record the
 * outcome rather than a promise. The template has always asked for
 * `archive: done`, but nothing read the line, so `archive: pending` passed
 * silently and a change could merge with its folder still active (PR #3592,
 * 2026-11-13).
 *
 * Presence stays optional: many legitimate bodies (chore-A, consumer lanes) do
 * not carry the line, and requiring it everywhere would churn every fixture
 * without adding evidence. What changes is that a present line can no longer
 * say `pending`:
 *   - `done...`              the archive landed in this PR
 *   - `deferred — <why>...`  the urgent-hotfix lane; must name why
 *   - `N/A: <why>`           this branch has no change folder
 */
function invalidArchiveDeclaration(body) {
  const section = extractH2Section(body, '## OpenSpec');
  if (!section) return null;
  // Accept a bare `archive:` line, a `- archive:` bullet, and a `- [ ] archive:`
  // checkbox: the promoted requirement says "carries an `archive:` line", so the
  // list marker must not decide whether the line is seen at all.
  const lines = section
    .split('\n')
    .filter((entry) => /^\s*(?:[-*]\s*(?:\[[ xX]\]\s*)?)?archive\s*[:：]/i.test(entry));
  if (lines.length === 0) return null;

  for (const line of lines) {
    const value = line
      .replace(/^\s*(?:[-*]\s*(?:\[[ xX]\]\s*)?)?archive\s*[:：]\s*/i, '')
      .trim();
    if (!value) return line.trim();
    // "pending" is a promise only when it IS the outcome. A named reason may
    // legitimately contain the word ("deferred — pending upstream fix"), so the
    // rejection stays exact rather than a substring match.
    if (/^pending\b/i.test(value)) return line.trim();
    if (/^done\b/i.test(value)) {
    // `done` is the only accepted outcome that takes free trailing text, so it is
    // also the only one that can contradict itself ("done — but pending").
    if (/\bpending\b/i.test(value)) return line.trim();
    continue;
  }
    if (/^deferred\b/i.test(value)) {
      const reason = value.replace(/^deferred\b\s*[-—:：]?\s*/i, '').trim();
      if (/^pending\s*$/i.test(reason)) return line.trim();
      if (reason.length >= 3 && !/^(?:<[^>]+>|reason|tbd|todo|none|-)$/i.test(reason)) continue;
      return line.trim();
    }
    if (/^N\/A\b/i.test(value)) {
      const reason = value.replace(/^N\/A\s*[:：]\s*/i, '').trim();
      if (/^pending\s*$/i.test(reason)) return line.trim();
      if (/^N\/A\s*[:：]\s*(?!\s*(?:<[^>]+>|reason|tbd|todo|none|-)\s*$).{3,}/i.test(value)) continue;
      return line.trim();
    }
    return line.trim();
  }
  return null;
}

function parseDisclosureArgs(argv) {
  let branch = '';
  let cwd = process.cwd();
  let prHead = '';
  let prBase = '';
  let prTargetUnresolved = false;
  let prCwd = '';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--pr-target-unresolved') {
      prTargetUnresolved = true;
      continue;
    }
    if (argv[i] === '--pr-cwd' && argv[i + 1]) {
      prCwd = argv[i + 1];
      i += 1;
      continue;
    }
    if (argv[i] === '--pr-head' && argv[i + 1]) {
      prHead = argv[i + 1];
      i += 1;
      continue;
    }
    if (argv[i] === '--pr-base' && argv[i + 1]) {
      prBase = argv[i + 1];
      i += 1;
      continue;
    }
    if (argv[i] === '--branch' && argv[i + 1]) {
      branch = argv[i + 1];
      i += 1;
      continue;
    }
    if (argv[i] === '--cwd' && argv[i + 1]) {
      cwd = argv[i + 1];
      i += 1;
    }
  }
  return { branch, cwd, prHead, prBase, prTargetUnresolved, prCwd };
}

/**
 * The PR the body is for: `head` is --pr-head, else the branch of --pr-cwd (never --branch), else --branch / the branch
 * of --cwd; `checkout` is --pr-cwd, else --cwd. null when the PR target is unresolved.
 */
function resolvePrTarget({ branch, cwd, prHead, prTargetUnresolved, prCwd }) {
  if (prTargetUnresolved) return null;
  return {
    head: prHead || (prCwd ? resolveBranch('', prCwd) : resolveBranch(branch, cwd)),
    checkout: prCwd || cwd,
  };
}

/** The head of the PR when it is a rules-lane sync head (#3529), else null; an unresolved PR target is never one. */
function rulesLaneSyncPrHead(args) {
  const target = resolvePrTarget(args);
  if (!target) return null;
  const root = (gitProbe(['rev-parse', '--show-toplevel'], target.checkout) ?? '').trim();
  return target.head && root && isRulesLaneSyncPrHead(target.head, root) ? target.head : null;
}

function resolveBranch(explicitBranch, cwd, timeout) {
  if (explicitBranch && explicitBranch.trim()) return explicitBranch.trim();
  const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd,
    encoding: 'utf8',
    ...(timeout ? { timeout } : {}),
  });
  if (r.status !== 0) return '';
  return (r.stdout || '').trim();
}

/**
 * Cross-check Cost Circuit Breaker Overrides against checkpoint via SSOT.
 * The checkpoint is the PR's (resolvePrTarget), not the session's: its head names the change and its checkout holds
 * the change folder. Unresolved PR target, unreadable head, or checkpoint missing/unreadable → skip with stderr
 * notice (fail-open; do not pretend cross-validation passed). Mismatch → fail exit 1.
 */
export function checkOverrideDisclosureContent({
  body,
  branch,
  cwd = process.cwd(),
  prHead = '',
  prTargetUnresolved = false,
  prCwd = '',
} = {}) {
  const target = resolvePrTarget({ branch, cwd, prHead, prTargetUnresolved, prCwd });
  if (!target) {
    return {
      status: 'skipped',
      reason: 'PR target unresolved — override disclosure cross-check skipped (not claimed pass)',
    };
  }
  if (!target.head || target.head === 'HEAD') {
    return {
      status: 'skipped',
      reason: 'branch unavailable — override disclosure cross-check skipped (not claimed pass)',
    };
  }
  const result = evaluateOverrideDisclosure({ branch: target.head, prBody: body, cwd: target.checkout });
  if (result.status === 'unavailable') {
    return {
      status: 'skipped',
      reason:
        'checkpoint unavailable — override disclosure cross-check skipped (not claimed pass)',
    };
  }
  if (result.status === 'block') {
    return {
      status: 'fail',
      reason: result.reason || 'override disclosure mismatch',
      ...(Array.isArray(result.expectedLines) ? { expectedLines: result.expectedLines } : {}),
    };
  }
  return { status: 'ok' };
}

const EVIDENCE_REFERENCE = '.devpro/agent-rules/git-pr-template-and-merge.md 證據段長度與字樣限制';
// Each git call of the evidence checks is bounded; a timeout counts as "cannot be read" (unknown), never as a block.
const GIT_TIMEOUT_MS = 5000;
const OBJECT_ID = /^[0-9a-f]{40,64}$/;

/** stdout of a git call, or null when it failed, timed out or could not start. */
function gitProbe(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
  if (r.error || r.status !== 0) return null;
  return r.stdout ?? '';
}

/**
 * State of refs/remotes/origin/<branch> against local HEAD (design D5 step 4); never touches the network.
 * Only a ref whose whole name matches counts (for-each-ref also lists deeper refs under the same prefix).
 */
function readRemoteTrackingState(branch, cwd) {
  const refName = `refs/remotes/origin/${branch}`;
  const listing = gitProbe(['for-each-ref', '--format=%(refname)%00%(objectname)', refName], cwd);
  if (listing === null) return { state: 'unreadable' };
  const row = listing.split('\n').map((line) => line.split('\0')).find(([name]) => name === refName);
  if (!row) return { state: 'missing' };
  const refSha = (row[1] || '').trim();
  const head = (gitProbe(['rev-parse', '--verify', 'HEAD'], cwd) || '').trim();
  if (!OBJECT_ID.test(refSha) || !OBJECT_ID.test(head)) return { state: 'unreadable' };
  return { state: refSha === head ? 'same' : 'differs' };
}

/**
 * Asks origin whether it has the branch (design D3 R14); called only when no refs/remotes/origin/<branch> exists.
 * 'absent' only on ls-remote's explicit "no matching ref" exit status (2); an answer that there is such a branch
 * (exit 0) and every failure (no origin remote, unreachable address, timeout, spawn error) are 'unknown'.
 * No fetch; GIT_TERMINAL_PROMPT=0 keeps git from prompting for credentials (an ssh prompt is bounded by the timeout).
 */
function askOriginForBranch(branch, cwd) {
  const r = spawnSync('git', ['ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${branch}`], {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    encoding: 'utf8',
  });
  if (r.error || r.signal) return { state: 'unknown', answer: 'origin 無法確認' };
  if (r.status === 2) return { state: 'absent' };
  if (r.status === 0) return { state: 'unknown', answer: 'origin 回答：有同名分支' };
  return { state: 'unknown', answer: 'origin 無法確認' };
}

/**
 * Local changed files against the base, with each file's change status (`statuses`: path -> status, the same
 * input the merge gate gives the chore-A exemption). `files: null` means "not known" and is never turned into
 * an empty list: an empty list is a real answer (git diff succeeded with no files) and would read as chore A.
 */
async function readChangedFiles({ prBase, cwd, importModule }) {
  let candidates;
  let tried;
  if (prBase) {
    candidates = [`origin/${prBase}`, prBase];
    tried = candidates.join(', ');
  } else {
    const { resolveCanonicalAgentsMdRef } = await importModule('./hooks/lib/git-utils.mjs');
    const ref = resolveCanonicalAgentsMdRef(cwd);
    candidates = ref ? [ref] : [];
    tried = 'origin/HEAD, origin/main, origin/master';
  }
  for (const ref of candidates) {
    if (ref.startsWith('-')) continue;
    if (gitProbe(['rev-parse', '--verify', '--quiet', ref], cwd) === null) continue;
    const out = gitProbe(['diff', '--name-status', '-z', '-M', `${ref}...HEAD`, '--'], cwd);
    if (out === null) break;
    const { parseGitNameStatusZ, toExemptionInput } = await importModule('./lib/changed-file-status.mjs');
    let entries;
    try {
      entries = parseGitNameStatusZ(out);
    } catch {
      break; // an unreadable diff is "not known", never a shorter list
    }
    const { files, statuses } = toExemptionInput(entries);
    return { files, statuses, count: entries.length, ref, tried };
  }
  return { files: null, statuses: null, count: 0, ref: '', tried };
}

/**
 * Will this PR be sent for a second opinion? 'required' | 'exempt' | 'unknown' (design D5). First hit wins.
 * Only 'required' runs the evidence checks; 'unknown' always fails open.
 */
async function resolveSecondReviewRequirement({ branch, cwd, prHead, prBase, prTargetUnresolved, prCwd, importModule }) {
  if (prTargetUnresolved) {
    return { state: 'unknown', reason: 'the PR head or base is not a literal value, or the branch was switched earlier in the same command' };
  }
  if (prCwd) {
    // The PR comes from another checkout: its own directory and its own branch decide, never --cwd or --branch.
    cwd = prCwd;
    branch = (gitProbe(['rev-parse', '--abbrev-ref', 'HEAD'], prCwd) ?? '').trim();
  }
  const localBranch = resolveBranch(branch, cwd, GIT_TIMEOUT_MS);
  if (!localBranch || localBranch === 'HEAD') {
    return { state: 'unknown', reason: 'the local branch is unavailable (empty or detached HEAD)' };
  }
  if (prHead && prHead !== localBranch) {
    return { state: 'unknown', reason: `--pr-head ${prHead} differs from local branch ${localBranch}` };
  }
  let remote = readRemoteTrackingState(localBranch, cwd);
  let originNote = '';
  if (remote.state === 'missing') {
    // No local ref proves nothing about the remote: ask origin. Only "origin has no such branch" (a first PR,
    // whose content is the local HEAD) continues down the `same` path.
    const asked = askOriginForBranch(localBranch, cwd);
    if (asked.state !== 'absent') {
      return { state: 'unknown', reason: `no remote-tracking ref origin/${localBranch} (${asked.answer})` };
    }
    remote = { state: 'same' };
    originNote = 'origin 沒有同名分支（首次 PR）';
  }
  if (remote.state === 'differs') {
    return { state: 'unknown', reason: `origin/${localBranch} differs from local HEAD` };
  }
  if (remote.state !== 'same') {
    return { state: 'unknown', reason: `the remote-tracking ref origin/${localBranch} or local HEAD could not be read` };
  }
  const changed = await readChangedFiles({ prBase, cwd, importModule });
  if (changed.files === null) {
    return { state: 'unknown', reason: `base unresolved (tried ${changed.tried})` };
  }
  const gate = await importModule('./hooks/pre-tool-gate.mjs');
  // Local HEAD is the PR head here (origin/<branch> equals it, or origin has no such branch yet).
  const headSha = (gitProbe(['rev-parse', 'HEAD'], cwd) ?? '').trim();
  // The base the diff was actually taken against (--base, or the default branch when gh pr create has none).
  const baseRefName = changed.ref.replace(/^origin\//, '');
  if (gate.isCrossModelExempt(localBranch, changed.files, cwd, changed.statuses, headSha, baseRefName)) {
    return { state: 'exempt', reason: gate.crossModelExemptionReason(localBranch, changed.files, cwd, changed.statuses, headSha, baseRefName) || 'isCrossModelExempt' };
  }
  return { state: 'required', branch: localBranch, base: changed.ref, changedFiles: changed.count, originNote };
}

function oneLine(error) {
  return String((error && error.message) || error).replace(/\s+/g, ' ').trim();
}

function formatEvidenceBlock(rules, findings, because) {
  const overLimit = findings.filter((item) => item.kind === 'over-limit');
  const fixes = [];
  if (overLimit.some((item) => item.field !== 'scope_summary')) {
    fixes.push('Over the limit: keep a short summary in that section and move the details to a separate ## Supplementary Evidence section.');
  }
  if (overLimit.some((item) => item.field === 'scope_summary')) {
    fixes.push('Over the limit (## Change Context): shorten it to a few lines saying what changes and why; the full explanation belongs in the proposal.');
  }
  if (findings.some((item) => item.kind === 'unfilled-template')) {
    fixes.push('Unfilled template text: replace it with the real content. An angle-bracket command template is accepted only inside inline code or a fenced code block, written as one ASCII token without spaces (for example <name>, <n>, <X.Y.Z>).');
  }
  return (
    'ERROR: PR body would be rejected by the second-review handoff builder (build-pr-sticky-handoff.mjs)\n' +
    'Findings:\n' +
    findings.map((item) => `  - ${rules.formatEvidenceFinding(item)}\n`).join('') +
    'Fix:\n' +
    fixes.map((line) => `  - ${line}\n`).join('') +
    `Checked because: second review required (${because})\n` +
    `Reference: ${EVIDENCE_REFERENCE}\n`
  );
}

/**
 * Evidence-section and Change Context checks (design D5-D7). Never rejects and never throws: any internal
 * failure, including a module that fails to load, is reported as `skipped` with exit code 0 (fail open).
 * `importModule` is the injection point for the two new dependencies' load failures.
 */
export async function runEvidenceSectionChecks({
  body,
  branch = '',
  cwd = process.cwd(),
  prHead = '',
  prBase = '',
  prTargetUnresolved = false,
  prCwd = '',
  importModule = (specifier) => import(specifier),
} = {}) {
  try {
    const rules = await importModule('./lib/pr-body-evidence-rules.mjs');
    const requirement = await resolveSecondReviewRequirement({ branch, cwd, prHead, prBase, prTargetUnresolved, prCwd, importModule });
    if (requirement.state !== 'required') {
      const why = requirement.state === 'exempt' ? `exempt: ${requirement.reason}` : `not verified: ${requirement.reason}`;
      return { status: 'skipped', exitCode: 0, stdout: `evidence-section checks: skipped (${why})\n`, stderr: '' };
    }
    const findings = [
      ...rules.evidenceFieldFindings(body, 'primary_validation_evidence'),
      ...rules.evidenceFieldFindings(body, 'primary_test_evidence'),
      ...rules.changeContextFindings(body),
    ].filter((item) => item.kind === 'over-limit' || item.kind === 'unfilled-template');
    const scope = `branch=${requirement.branch}; base=${requirement.base}; changed files=${requirement.changedFiles}`;
    const scopeWithOrigin = requirement.originNote ? `${scope}; ${requirement.originNote}` : scope;
    if (findings.length === 0) {
      return { status: 'checked', exitCode: 0, stdout: `evidence-section checks: checked (second review required; ${scopeWithOrigin})\n`, stderr: '' };
    }
    return { status: 'blocked', exitCode: 1, stdout: '', stderr: formatEvidenceBlock(rules, findings, scopeWithOrigin) };
  } catch (error) {
    return { status: 'skipped', exitCode: 0, stdout: `evidence-section checks: skipped (internal error: ${oneLine(error)})\n`, stderr: '' };
  }
}

// CLI entry
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const body = readBodyFromFileArgOrStdin({ argv: process.argv });

  if (!body) {
    process.stderr.write('ERROR: PR body input is empty or unreadable\n');
    process.exit(2);
  }

  const { branch, cwd, prHead, prBase, prTargetUnresolved, prCwd } = parseDisclosureArgs(process.argv.slice(2));
  const rulesLaneHead = rulesLaneSyncPrHead({ branch, cwd, prHead, prTargetUnresolved, prCwd });
  const missing = MANDATORY_PHRASES
    .filter(({ label }) => !(rulesLaneHead && label === REQUIREMENT_LEDGER_LABEL))
    .filter(({ test }) => !test(body))
    .map(({ label }) => label);

  const advisoryMissing = ADVISORY_PHRASES
    .filter(({ test }) => !test(body))
    .map(({ label }) => label);

  if (advisoryMissing.length > 0) {
    process.stderr.write(
      `ADVISORY: PR body missing recommended Test Evidence coverage line(s)\n` +
        advisoryMissing.map((label) => `  - ${label}`).join('\n') +
        `\nReference: ${REFERENCE} (advisory-only; does not fail this check)\n`
    );
  }

  if (!RELEASE_TARGET_ADVISORY.test(body)) {
    process.stderr.write(
      `ADVISORY: PR body missing the recommended Release Target line\n` +
        `  - ${RELEASE_TARGET_ADVISORY.label} (與 PR milestone 一致；warn-only，不阻擋 PR)\n` +
        `Reference: ${REFERENCE} (advisory-only; does not fail this check)\n`
    );
  }

  const archiveProblem = invalidArchiveDeclaration(body);
  if (archiveProblem) {
    process.stderr.write(
      `ERROR: PR body OpenSpec archive line does not record an outcome\n` +
        `  offending line: ${archiveProblem}\n` +
        `  allowed: \`done\`, \`deferred — <why>\`, or \`N/A: <why>\`; \`pending\` is not an outcome\n` +
        `Reference: ${REFERENCE}\n`
    );
    process.exit(1);
  }

  if (missing.length > 0) {
    let msg =
      `ERROR: PR body missing canonical template phrases\n` +
      `Missing:\n` +
      missing.map(label => `  - ${label}`).join('\n') + '\n';
    msg += `Reference: ${REFERENCE}\n`;
    process.stderr.write(msg);
    process.exit(1);
  }

  const disclosure = checkOverrideDisclosureContent({ body, branch, cwd, prHead, prTargetUnresolved, prCwd });
  if (disclosure.status === 'skipped') {
    process.stderr.write(`ADVISORY: ${disclosure.reason}\n`);
  } else if (disclosure.status === 'fail') {
    const expected = Array.isArray(disclosure.expectedLines) && disclosure.expectedLines.length > 0
      ? `Expected section body (derived from the checkpoint; paste line by line):\n` +
        disclosure.expectedLines.map((line) => `${line}\n`).join('')
      : '';
    process.stderr.write(
      `ERROR: Cost Circuit Breaker Overrides disclosure mismatch\n` +
        `  ${disclosure.reason}\n` +
        expected +
        `Reference: evaluateOverrideDisclosure (post-pr-cost-circuit-breaker.mjs)\n`
    );
    process.exit(1);
  }

  // Runs after every existing check; exit 1 only for a required PR with a finding, never exit 2.
  const evidence = await runEvidenceSectionChecks({ body, branch, cwd, prHead, prBase, prTargetUnresolved, prCwd });
  if (evidence.exitCode !== 0) {
    process.stderr.write(evidence.stderr);
    process.exit(evidence.exitCode);
  }

  process.stdout.write('OK: PR body template canonical phrases present\n');
  if (rulesLaneHead) process.stdout.write(`Requirement Ledger Completion: N/A (rules lane sync PR ${rulesLaneHead})\n`);
  process.stdout.write(evidence.stdout);
  process.exit(0);
}
