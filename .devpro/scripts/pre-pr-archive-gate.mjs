#!/usr/bin/env node
/**
 * Pre-PR archive gate (per archive-tooling/Pre-PR Archive Gate Enforcement)
 *
 * (a) No active change folder under openspec/changes/ (only archive/ allowed)
 * (b) Each PR-touched relevant archive's capability specs all promoted to
 *     openspec/specs/<cap>/spec.md (empty relevant-archive set evaluates zero
 *     archives — scope-bound per issue #1847)
 * (c) Each PR-touched relevant archive's proposal.md/proposal-mini.md has '## Why'
 *     and '## What Changes' headings (issue #386 — without these, openspec
 *     archive does NOT generate openspec/specs/<cap>/spec.md; empty relevant-archive
 *     set evaluates zero archives — scope-bound per issue #1847).
 *     Extended (enforce-batch-scope-ledger-presence, design.md D1/D2/D3) with a
 *     '## Batch Approval Ledger' presence + shape check, two independent
 *     failure branches in the same loop: (1) heading absent — merged into the
 *     same missingHeadings array as '## Why'/'## What Changes', byte-identical
 *     message/exit path; (2) heading present but
 *     `evaluateBatchApprovalLedgerShape()` (`.devpro/scripts/lib/batch-approval-ledger.mjs`)
 *     returns 'shapeless' (N/A sentinel or all identity-independent required
 *     fields must be present — see module doc) — independent stderr + Fix:
 *     line, NOT folded into missingHeadings.
 * (d) Issue Anchor Verification: each archive folder this PR's diff touches must
 *     have proposal with '## Issue Anchor Verification' heading + grep evidence
 *     (scope-bound per issue #497 — was latest-only before; now iterates archives
 *     in `git diff origin/main...HEAD`. Prevents unrelated PRs being blocked by
 *     pre-existing debt in latest archive folder.)
 * (e) Objective Rule Token Budget: build one authoritative committed/staged/
 *     unstaged/untracked name-status manifest and measure the final bytes of each
 *     actual rule carrier. Proposal prose is never measurement evidence.
 * (e2) Pre-review cross-carrier remediation closure: when the latest sealed
 *     receipt is partial/blocked with open findings, require one replay-valid
 *     exact classification record before another reviewer dispatch. Fixed
 *     literal coverage is mechanical; semantic discovery remains reviewer-owned.
 * (f) Periodic Rationalization Cadence: source-maintainer-only advisory over
 *     relevant archive topology since the private one-time epoch locator.
 * (g) Dedup Audit: when the authoritative manifest proves definite bounded
 *     source-governance topology, each relevant full proposal must contain
 *     ## File-Role Ledger + ## Dedup Audit 三步結果 sections (scope-bound per
 *     #497; per proposal-template.md §File-Role Ledger and §Dedup Audit 三步結果).
 * (h) Archive spec.md drift detection: post-archive-commit modification of
 *     openspec/changes/archive/<date>-<name>/specs/<cap>/spec.md indicates that
 *     archive content was edited but `openspec/specs/<cap>/spec.md` global spec
 *     was NOT synchronously promoted via `openspec archive`. SSOT drift risk.
 *     Scope-bound to archive folders touched by the PR diff, matching checks
 *     (d)/(e)/(g), so unrelated historical archive debt does not block PRs.
 *     Heuristic: git log <spec-path> commit count > 1 → block. Do not
 *     use --follow: normal archive commits rename active spec deltas into
 *     archive, and pre-archive active-path history is not archive drift.
 * (i) Capability spec scenario removal guard (issue #722): for each
 *     openspec/specs/<cap>/spec.md the branch modifies, compare `#### Scenario:`
 *     titles at the merge-base of baseline ref and HEAD vs HEAD. Block when
 *     fork-time titles disappear without an explicit `## Removed Scenarios`
 *     declaration in any relevant archive's proposal-mini.md / proposal.md /
 *     tasks.md / decisions.md, or, for a PR with no archive below full rigor,
 *     in the PR body named by `--pr`. Scenarios added on the baseline branch after
 *     this branch forked are not removals by this branch. Covers the
 *     `openspec archive` failure mode where a `## MODIFIED Requirements` delta
 *     containing only new scenarios is applied as a REPLACEMENT, silently
 *     dropping existing scenarios. `openspec validate` accepts the result;
 *     only a baseline-vs-HEAD scenario diff catches it.
 * (m) Requirement Ledger lifecycle gate: each PR-touched relevant archive's
 *     proposal/proposal-mini must contain a parseable `## Requirement Ledger`
 *     table with lineage columns, accepted dispositions, owner/next-step trace
 *     for non-implemented rows, and bidirectional task coverage.
 * (n) Promoted spec archive placeholder gate (issue #1218): for each PR-touched
 *     relevant archive with a `specs/<cap>/` subdirectory, read the `## Purpose`
 *     section of the canonical `openspec/specs/<cap>/spec.md` and grep for the
 *     literal phrase `TBD - created by archiving`. A hit means the archive
 *     placeholder was never replaced with real Purpose content after
 *     `openspec archive` — exit 1 with stderr identifying the spec and instructing
 *     the author to fill in `## Purpose`. Scope-bound to `relevantArchives`
 *     (fail-open when empty, so pre-existing placeholder specs in the repo do not
 *     block unrelated PRs).
 *     Mechanical enforcement point: this file + `.devpro/scripts/tests/pre-pr-archive-gate.test.mjs`.
 * (p) Archive promotion completeness assertion: for each PR-touched relevant
 *     archive with `specs/<cap>/spec.md`, compare the archived ADDED/MODIFIED
 *     Requirement headings, Scenario headings, and normative body lines against
 *     the promoted canonical `openspec/specs/<cap>/spec.md`. A missing assertion
 *     means `openspec archive` or a manual repair promoted headings without the
 *     behavioral text — exit 1 with the missing archive/cap/assertion. An
 *     assertion that was present at the archive's origin/main landing commit
 *     and is already gone from origin/main is a later rewrite, not a missing
 *     promotion (advisory only; looked up on the red path only).
 * (q) design.md format-when-present check (BRD FR5 / Cooperative watershed):
 *     design.md is NEVER required to exist (no presence gate). But for each
 *     PR-touched relevant archive that DOES contain `design.md`, its
 *     hook-enforced required headings (`## Context`, `## Decisions` — single
 *     SSOT: `.devpro/agent-rules/design-template.md`) must be present — exit 1
 *     identifying the archive and missing heading(s). Scope-bound to
 *     relevantExistingArchives (mirrors (o)), so a pre-existing (Grandfather)
 *     design.md this PR did not touch is never retroactively validated.
 * (r) Readability Signal: actual objective utilization >= 80% emits
 *     `semanticReview=required`. It is an advisory review-routing signal only;
 *     the machine never parses proposal evidence or emits a semantic pass/fail
 *     verdict, and ordinary PRs have no forced compression obligation.
 *     Objective over-cap alone soft-warns (`cap-pressure=over`) and exits 0;
 *     definition integrity / unknown remain fail-closed.
 *
 * Exit 0 = pass; exit 1 = block + stderr message identifying violation.
 */

import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { spawnSync, execSync } from 'node:child_process';
import path from 'node:path';
import { PROPOSAL_CARRIERS } from './lib/proposal-carriers.mjs';
import {
  activeContentLintRemediationText,
  isActiveContentLintUnavailable,
} from './lib/active-content-lint-remediation.mjs';
import { classifyExistingBrdDirectory, classifyOwnedChangeBrd, validateRequiredBrd } from './lib/brd-required-headings.mjs';
import { extractDeclaredLoadChainRefs } from './lib/load-chain-declarations.mjs';
import { collectRemovedScenarios, parseRemovedScenariosFromBody } from './lib/removed-scenarios.mjs';
import { resolveRigorLevel } from './hooks/lib/rigor-level.mjs';
import { evaluateBatchApprovalLedgerShape, legacyExcludesNotice } from './lib/batch-approval-ledger.mjs';

const NAME_STATUS_TOKEN = /^(?:[ACDMRTUXB?]|R\d{1,3}|C\d{1,3})$/;
import {
  DEFAULT_PROVE_IT_RE,
  findProveItInTaskLedgerCarriers,
  resolveExecutableTaskLedgerCarrier,
  TASK_LEDGER_CARRIER_CANDIDATES,
} from './lib/task-ledger-resolution.mjs';
import { lintProposalTasksChecked } from './lint-proposal-tasks-checked.mjs';
import {
  isRuleTokenCarrier,
  measureRuleTokenBudget,
  normalizeRepoPath,
} from './lib/rule-token-budget.mjs';
import { emitCapPressureSoftWarn } from './lib/cap-pressure-soft-warn.mjs';
import { normalizeLedgerCell, hasRequirementId } from './lib/requirement-ledger-rows.mjs';
import { readRequirementLedger } from './lib/requirement-ledger.mjs';
import {
  collectCoverageLedgerRows,
  compareRequirementTaskCoverage,
} from './lib/requirement-task-coverage.mjs';
import { evaluateRegressionHeadCurrency } from './lib/regression-head-record.mjs';
import { classifyRepoIdentity } from './lib/repo-identity.mjs';

/**
 * 統一所有 success-exit 的可觀測輸出（per cross-model review PR #841 I5 補完）。
 * - A 類（archive 真 promote 成功）：印 `archived as '<name>'` evidence token，
 *   讓 `/devpro:pre-pr` / PR body 可以引用「pre-pr archive 流程跑過」的 stdout
 *   evidence。情境：最終 promote 成功、(i) scenario-removal check 因 rules 分支或非 git repo 而 skip（但 (a)-(h)
 *   已 pass、archive 已真 promote）。
 * - B 類（無 archive 可言的 pass-through）：印 pass 說明，不印 evidence token——
 *   情境為「沒有 OpenSpec change 要 archive」（無 openspec/changes 目錄 / 無 archive
 *   目錄 / 無 archives / chore-A 無 spec delta）。
 *   B 類不印 token 安全的理由：沒有 archive 可 promote 時，`archived as` 不該
 *   假造；readiness evidence 由 `/devpro:pre-pr` 的 validate/review/test output 承接，
 *   不再由 PreToolUse transcript regex 判定 merge readiness。
 */
function passArchiveGate(reason, archiveName = null) {
  if (archiveName) process.stdout.write(`archived as '${archiveName}'\n`);
  printEffectiveScopeAdvisories();
  printReviewLedgerCompactnessAdvisory(archiveName);
  process.stdout.write(`Pre-PR archive gate: pass (${reason})\n`);
  process.exit(0);
}

const effectiveScopeAdvisories = [];

// R8/D8: evidence-archive name captured once it is computed, so pass paths
// that deliberately omit the `archived as` token (B類 pass-through, e.g.
// "chore-A or no spec delta") still surface the compactness advisory.
let compactnessArchiveName = null;

function addEffectiveScopeAdvisory(message) {
  if (!message) return;
  if (!effectiveScopeAdvisories.includes(message)) effectiveScopeAdvisories.push(message);
}

// R8/D8 (strengthen-cross-review-loop-termination): advisory-only post-archive
// review-ledger compactness. Never blocks and is NOT a lettered check — it
// rides the pass-path output layer only, measured from the evidence archive's
// introduction commit (post-archive growth only, via
// lint-review-ledger-compactness.mjs). Any probe/lint failure is silent:
// the advisory MUST NOT change the gate outcome.
function printReviewLedgerCompactnessAdvisory(archiveName) {
  const target = archiveName || compactnessArchiveName;
  if (!target) return;
  try {
    const lintScript = path.join(path.dirname(process.argv[1] || ''), 'lint-review-ledger-compactness.mjs');
    if (!existsSync(lintScript)) return;
    const introduction = loadArchiveIntroduction(cwd, target);
    if (introduction.unknown || !introduction.sha) return;
    const lintArgs = [lintScript, `openspec/changes/archive/${target}`, '--base', introduction.sha];
    // Thread the optional --pr through (see parseCliArgs) so this advisory's
    // compactness denominator can use the pr-sticky round-budget sidecar's
    // round_count instead of always falling back to round_count_unavailable
    // (WARN remediation for the "carrier_class: code" cross-model finding —
    // pre-pr-archive-gate.mjs previously had zero PR-number CLI awareness).
    if (prNumber) lintArgs.push('--pr', prNumber);
    const lint = spawnSync(
      process.execPath,
      lintArgs,
      { cwd, encoding: 'utf8' }
    );
    if (!lint.error && lint.status === 0 && lint.stdout) process.stdout.write(lint.stdout);
  } catch {
    // advisory only
  }
}

function firstFailureLine(result) {
  const raw =
    result?.stderr ||
    result?.stdout ||
    result?.error?.message ||
    result?.error ||
    (result?.status !== undefined ? `exit ${result.status}` : '') ||
    'unknown failure';
  return String(raw)
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) || 'unknown failure';
}

function printEffectiveScopeAdvisories() {
  for (const message of effectiveScopeAdvisories) {
    process.stdout.write(`Pre-PR archive gate effective-scope advisory: ${message}\n`);
  }
}

// Mirror of RULES_BRANCH_RE from .devpro/scripts/hooks/lib/branch-naming.mjs.
// Inlined (not imported) because lib/branch-naming.mjs has a transitive
// dep chain (shell-context.mjs, git-utils.mjs) that test fixtures isolate
// per script. Keep BYTE-FOR-BYTE in sync — see issue #784 PR review notes;
// if branch-naming.mjs changes the regex, update here too (token-first
// duplication acceptable per rule-design-principles.md 守則 3 "leaf
// 自含 > DRY"; both call sites already documented).
const RULES_BRANCH_RE = /^rules\/[a-z][a-z0-9-]*-v\d+\.\d+\.\d+$/;

/**
 * Parse this script's own CLI args independently of the pre-existing single
 * positional cwd arg (`process.argv[2]`). `--pr <n>` is OPTIONAL and additive:
 * absent → identical behavior to before this parser existed (cwd resolution
 * unchanged; printReviewLedgerCompactnessAdvisory omits --pr from its
 * lint-review-ledger-compactness.mjs call, same as pre-fix). Present + valid
 * (1-8 digit string) → threaded through as the compactness advisory's D8
 * round-budget sidecar denominator lookup key. `--mid-batch` (issue #2430)
 * is OPTIONAL: skip check (a) so a remaining sibling active folder does not
 * deadlock a per-archive check (i) rerun; it is NOT the final pre-PR gate
 * (pre-tool-gate Gate 3b MUST NOT pass this flag). Any other flag is ignored.
 */
function parseCliArgs(argv) {
  const rest = argv.slice(2);
  let positionalCwd = null;
  let pr = null;
  let midBatch = false;
  let preReview = false;
  let baselineRef = null;
  let changeBaseRef = null;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--pr') {
      pr = rest[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (arg === '--baseline-ref') {
      baselineRef = rest[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (arg === '--change-base-ref') {
      changeBaseRef = rest[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (arg === '--mid-batch') {
      midBatch = true;
      continue;
    }
    if (arg === '--pre-review') {
      preReview = true;
      continue;
    }
    if (positionalCwd === null && !arg.startsWith('--')) {
      positionalCwd = arg;
    }
  }
  return {
    cwd: positionalCwd || process.cwd(),
    pr: pr !== null && /^\d{1,8}$/.test(pr) ? pr : null,
    midBatch,
    preReview,
    baselineRef,
    changeBaseRef,
  };
}

const {
  cwd,
  pr: prNumber,
  midBatch,
  preReview,
  baselineRef: cliBaselineRef,
  changeBaseRef: cliChangeBaseRef,
} = parseCliArgs(process.argv);
if (midBatch && preReview) {
  process.stderr.write('Pre-PR archive gate: --mid-batch and --pre-review are different phases and MUST NOT be combined.\n');
  process.exit(1);
}
const changesDir = path.join(cwd, 'openspec/changes');
// Both gate (e) call sites (`--pre-review` and post-archive) and cadence (f)
// read one identity probe: `classifyRepoIdentity` spawns git twice and `cwd` is
// fixed for the run. Declared above the `--pre-review` call site so neither
// phase hits the temporal dead zone.
const repoIdentity = classifyRepoIdentity(cwd);
// Shared by the pre-review active-change reader and the post-archive readers.
const proposalCandidates = PROPOSAL_CARRIERS;

/**
 * Compute the set of archive folders this PR's diff touches. Used by
 * gates (d)/(e)/(g) so that pre-existing debt in untouched archives does
 * not block PRs with unrelated scope (per issue #497).
 *
 * Resolution order:
 *   1. `DEVPRO_RELEVANT_ARCHIVES` env var — comma-separated folder names.
 *      Used by tests (fixtures lack git history) and as a manual override.
 *      Empty string → relevant set is empty (gates skip).
 *   2. Git working-copy probes covering committed diff, staged diff, unstaged
 *      tracked diff, and untracked archive paths. `/devpro:pre-pr` often runs
 *      before the archive folder is committed, so untracked paths must count.
 *   3. If every git probe is unavailable / fails → return `{ folders: [], paths: [] }`
 *      (gates skip; fail-open rather than fall back to legacy latest-only
 *      behavior, since latest-only is exactly the false-positive pattern we
 *      are fixing).
 *
 * Returns BOTH the archive folder names and the full repo-relative paths seen
 * by the same probe pass. `getTouchedArchiveSpecPaths` filters those paths down
 * to spec carriers for check (p). Deriving both from ONE pass is load-bearing,
 * not a micro-optimisation: a second independent probe pass could observe a
 * different file state (e.g. an untracked file appearing in between), yielding
 * a folder that is in the relevance set whose spec paths are absent from the
 * carrier set — the guard would then decide on one set and draw evidence from
 * another, which is exactly the defect class this change fixes.
 */
function collectArchiveFoldersFromProbes(cwdArg, probes, advisoryLabel) {
  const folders = new Set();
  const paths = new Set();

  function collect(stdout) {
    for (const raw of stdout.split('\n')) {
      const line = raw.replace(/\r$/, '');
      const m = line.match(/^openspec\/changes\/archive\/([^\/]+)/);
      if (m) {
        folders.add(m[1]);
        paths.add(line);
      }
    }
  }

  const failedProbes = [];
  for (const args of probes) {
    const result = spawnSync('git', ['-C', cwdArg, ...args], { encoding: 'utf8' });
    if (!result.error && result.status === 0) {
      collect(result.stdout || '');
    } else {
      failedProbes.push({
        args,
        reason: firstFailureLine(result),
      });
    }
  }

  if (failedProbes.length > 0) {
    const scope = Array.from(folders).sort();
    addEffectiveScopeAdvisory(
      `${advisoryLabel} probe degraded: ${failedProbes.length}/${probes.length} git probe(s) failed; ` +
      `${advisoryLabel} set=${scope.length > 0 ? scope.join(', ') : '(empty)'}; ` +
      `first failure: git ${failedProbes[0].args.join(' ')}: ${failedProbes[0].reason}.`
    );
  }

  return { folders: Array.from(folders), paths: Array.from(paths) };
}

/**
 * Resolve the three-dot baseline for archive relevance / added-set probes only
 * (GH-2546). MUST NOT reuse DEVPRO_SCENARIO_DIFF_BASELINE_REF (gate i / GH-2508).
 * Order: DEVPRO_ARCHIVE_RELEVANCE_BASELINE_REF → --baseline-ref → --pr gh base →
 * current-branch gh base → origin/main + advisory.
 */
function isSafeArchiveRelevanceRef(ref) {
  // Allow Unicode branch names (GH-2546 consumer bases e.g. feature/新大戶).
  // Reject leading '-' (option injection) and shell/control metacharacters.
  // JS \w is ASCII-only — do not use it here.
  if (typeof ref !== 'string' || ref.length === 0 || ref.startsWith('-')) return false;
  if (/[\0\s\\$`|;<>&"'(){}[\]*?~]/.test(ref)) return false;
  return /^[\p{L}\p{N}._/@\-]+$/u.test(ref);
}

function tryGhPullRequestBaseRefName(cwdArg, prSelector) {
  const args = prSelector
    ? ['pr', 'view', String(prSelector), '--json', 'baseRefName', '--jq', '.baseRefName']
    : ['pr', 'view', '--json', 'baseRefName', '--jq', '.baseRefName'];
  try {
    const result = spawnSync('gh', args, {
      cwd: cwdArg,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    if (result.error || result.status !== 0) return null;
    const name = (result.stdout || '').trim();
    return name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

/**
 * Removal declarations a lite change wrote in its PR body. A lite change never archives, so the archive files that
 * hold `## Removed Scenarios` do not exist for it; the PR body is the record reviewers read. Only the body of a PR
 * named with `--pr` and opened from the current branch counts. `note` tells the author what to do next.
 */
function readPrBodyRemovedScenarios(cwdArg, prSelector) {
  const none = (note) => ({ titles: new Set(), note });
  if (!prSelector) {
    return none('lite 沒有 archive：在 PR 說明加同樣的 `## Removed Scenarios` 段，再以 --pr <n> 重跑本 gate。');
  }
  const view = spawnSync('gh', ['pr', 'view', String(prSelector), '--json', 'body,headRefName'], {
    cwd: cwdArg,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  let pullRequest = null;
  try {
    if (!view.error && view.status === 0) pullRequest = JSON.parse(view.stdout);
  } catch {}
  if (typeof pullRequest?.body !== 'string' || typeof pullRequest?.headRefName !== 'string') {
    return none(`PR #${prSelector} 的說明讀不到，不能當作宣告；確認 gh 可用且 PR 存在後重跑本 gate。`);
  }
  const branch = spawnSync('git', ['-C', cwdArg, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' });
  const currentBranch = (branch.stdout || '').trim();
  if (pullRequest.headRefName !== currentBranch) {
    return none(`PR #${prSelector} 的分支是 ${pullRequest.headRefName}，不是目前的 ${currentBranch}，不能當作宣告。`);
  }
  return {
    titles: parseRemovedScenariosFromBody(pullRequest.body),
    note: `PR #${prSelector} 的 PR 說明沒有列出上述標題；在 \`## Removed Scenarios\` 段逐行補上後重跑本 gate。`,
  };
}

function revParseCommit(cwdArg, ref) {
  const probed = spawnSync(
    'git',
    ['-C', cwdArg, 'rev-parse', `${ref}^{commit}`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  return !probed.error && probed.status === 0 && (probed.stdout || '').trim()
    ? (probed.stdout || '').trim()
    : null;
}

function resolveRemoteOrLocalRef(cwdArg, baseRefName) {
  if (!baseRefName || !isSafeArchiveRelevanceRef(baseRefName)) return null;
  for (const candidate of [`origin/${baseRefName}`, baseRefName]) {
    if (!isSafeArchiveRelevanceRef(candidate)) continue;
    if (revParseCommit(cwdArg, candidate)) return candidate;
  }
  return null;
}

function requireResolvableArchiveRelevanceRef(cwdArg, ref, label) {
  if (!revParseCommit(cwdArg, ref)) {
    process.stderr.write(
      `Pre-PR archive gate: ${label} does not resolve to a commit: ${JSON.stringify(ref)}\n` +
      `Fail-closed.\n`,
    );
    process.exit(1);
  }
}

function resolveArchiveRelevanceBaselineRef(cwdArg) {
  const envRef = process.env.DEVPRO_ARCHIVE_RELEVANCE_BASELINE_REF;
  if (envRef !== undefined && String(envRef).length > 0) {
    if (!isSafeArchiveRelevanceRef(envRef)) {
      process.stderr.write(
        `Pre-PR archive gate: DEVPRO_ARCHIVE_RELEVANCE_BASELINE_REF shape invalid: ${JSON.stringify(envRef)}\n` +
        `Fail-closed.\n`,
      );
      process.exit(1);
    }
    requireResolvableArchiveRelevanceRef(cwdArg, envRef, 'DEVPRO_ARCHIVE_RELEVANCE_BASELINE_REF');
    return { ref: envRef, source: 'env' };
  }
  if (cliBaselineRef !== null && cliBaselineRef !== undefined) {
    if (!isSafeArchiveRelevanceRef(cliBaselineRef)) {
      process.stderr.write(
        `Pre-PR archive gate: --baseline-ref shape invalid: ${JSON.stringify(cliBaselineRef)}\n` +
        `Fail-closed.\n`,
      );
      process.exit(1);
    }
    requireResolvableArchiveRelevanceRef(cwdArg, cliBaselineRef, '--baseline-ref');
    return { ref: cliBaselineRef, source: 'cli' };
  }
  if (prNumber) {
    const fromPr = resolveRemoteOrLocalRef(cwdArg, tryGhPullRequestBaseRefName(cwdArg, prNumber));
    if (fromPr) return { ref: fromPr, source: 'gh-pr' };
  }
  const fromBranch = resolveRemoteOrLocalRef(cwdArg, tryGhPullRequestBaseRefName(cwdArg, null));
  if (fromBranch) return { ref: fromBranch, source: 'gh-current' };
  return { ref: 'origin/main', source: 'fallback-origin-main' };
}

let archiveRelevanceBaseline = null;
function getArchiveRelevanceBaseline(cwdArg) {
  if (!archiveRelevanceBaseline) {
    archiveRelevanceBaseline = resolveArchiveRelevanceBaselineRef(cwdArg);
    if (archiveRelevanceBaseline.source === 'fallback-origin-main') {
      // Quiet on bare main/release fixtures (case 4c expects no effective-scope advisory).
      // Warn on feature/bugfix/hotfix/chore lines (GH-2546 risk class, incl. chore/* non-main bases).
      const branchHint = typeof currentBranch === 'string' ? currentBranch : '';
      const maybeNonMainLine = /^(feature|bugfix|hotfix|chore)\//.test(branchHint);
      if (maybeNonMainLine) {
        addEffectiveScopeAdvisory(
          `archive relevance baseline assumed origin/main (no DEVPRO_ARCHIVE_RELEVANCE_BASELINE_REF / --baseline-ref / resolvable PR base); ` +
          `set --baseline-ref or DEVPRO_ARCHIVE_RELEVANCE_BASELINE_REF for non-main PR bases (GH-2546).`,
        );
      }
    } else {
      addEffectiveScopeAdvisory(
        `archive relevance baseline=${archiveRelevanceBaseline.ref} (source=${archiveRelevanceBaseline.source}).`,
      );
    }
  }
  return archiveRelevanceBaseline.ref;
}

function getRelevantArchives(cwdArg) {
  if (process.env.DEVPRO_RELEVANT_ARCHIVES !== undefined) {
    return process.env.DEVPRO_RELEVANT_ARCHIVES
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return probeArchiveRelevance(cwdArg).folders;
}

/**
 * Run the archive-relevance probe pass exactly ONCE per process and memoize
 * both projections of it. `getRelevantArchives` reads `.folders`;
 * `getTouchedArchiveSpecPaths` reads `.paths`. Same pass by construction —
 * see `collectArchiveFoldersFromProbes`.
 */
let archiveRelevanceProbe = null;
function probeArchiveRelevance(cwdArg) {
  if (archiveRelevanceProbe) return archiveRelevanceProbe;
  const baseline = getArchiveRelevanceBaseline(cwdArg);
  archiveRelevanceProbe = collectArchiveFoldersFromProbes(cwdArg, [
    ['diff', '--name-only', `${baseline}...HEAD`, '--', 'openspec/changes/archive/'],
    ['diff', '--name-only', '--cached', '--', 'openspec/changes/archive/'],
    ['diff', '--name-only', '--', 'openspec/changes/archive/'],
    ['ls-files', '--others', '--exclude-standard', '--', 'openspec/changes/archive/'],
  ], 'archive relevance');
  return archiveRelevanceProbe;
}

/**
 * Compute the set of archive folders newly ADDED (not merely touched) by
 * this PR's diff — narrower than `getRelevantArchives`. Used only by the
 * `## Batch Approval Ledger` presence/shape sub-check inside check (c), so a
 * PR that merely edits some file inside a pre-existing historical archive
 * (e.g. a docs backfill into an old change folder) is not blocked by that
 * archive lacking a ledger it predates (enforce-batch-scope-ledger-presence
 * is purely additive going forward, not retroactive — see decisions.md
 * "T12 後覆核"). The `## Why`/`## What Changes` sub-checks stay scoped to
 * `getRelevantArchives` unchanged (pre-existing behavior, out of scope here).
 *
 * Pathspec is narrowed to `proposal.md`/`proposal-mini.md` themselves, NOT
 * the whole `openspec/changes/archive/` tree: `--diff-filter=A` is file-level,
 * so a PR that only *adds* some other file into an already-archived folder
 * (e.g. backfilling a `qa-test-scope.md` into a change archived weeks
 * earlier — a real historical pattern, see decisions.md round-2 finding C-C)
 * would otherwise re-flag that historical archive as "added" and re-trigger
 * the ledger check on a proposal it predates. Requiring the proposal file
 * itself to be the Added path keeps true positives (a real `openspec
 * archive` commit always adds the proposal alongside the folder) while
 * excluding this false-positive class. Rename/copy detection does not
 * interfere here: pathspec-scoped diffs report the archived proposal as a
 * plain `A`, not `R100`, because rename detection needs the unscoped
 * full-tree diff to see both the pre-image and post-image paths.
 *
 * Falls back to `getRelevantArchives`'s value when `DEVPRO_RELEVANT_ARCHIVES`
 * is set but `DEVPRO_ADDED_ARCHIVES` is not, so existing test fixtures
 * (which set only the former) keep their current pass/fail behavior.
 */
function getAddedArchives(cwdArg) {
  if (process.env.DEVPRO_ADDED_ARCHIVES !== undefined) {
    return process.env.DEVPRO_ADDED_ARCHIVES
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (process.env.DEVPRO_RELEVANT_ARCHIVES !== undefined) {
    return getRelevantArchives(cwdArg);
  }
  const proposalPathspecs = [
    'openspec/changes/archive/*/proposal.md',
    'openspec/changes/archive/*/proposal-mini.md',
  ];
  const baseline = getArchiveRelevanceBaseline(cwdArg);
  return collectArchiveFoldersFromProbes(cwdArg, [
    ['diff', '--name-only', '--diff-filter=A', `${baseline}...HEAD`, '--', ...proposalPathspecs],
    ['diff', '--name-only', '--diff-filter=A', '--cached', '--', ...proposalPathspecs],
    ['diff', '--name-only', '--diff-filter=A', '--', ...proposalPathspecs],
    ['ls-files', '--others', '--exclude-standard', '--', ...proposalPathspecs],
  ], 'archive added-set').folders;
}

/**
 * Spec-carrier granularity for check (p) (defect A).
 *
 * check (p) used to evaluate EVERY `specs/<cap>/spec.md` under every archive
 * folder this PR touches. A PR that only edits a non-spec file inside some
 * archive (a brd tweak, a trailing blank line in `qa-test-scope.md`) therefore
 * inherited that whole archive's promotion backlog — PR #2744 was blocked by
 * deleting one blank line in an unrelated file. Narrowing the MATERIAL to the
 * spec carriers the diff actually touches removes that false red without
 * touching any fail-closed criterion: a touched spec.md is still evaluated by
 * the exact same rules, with the exact same message fields.
 *
 * Shares the single probe pass with `getRelevantArchives` (see
 * `collectArchiveFoldersFromProbes`); adds no git calls (NFR3).
 *
 * Returns `null` to mean NO narrowing (evaluate every cap under every relevant
 * archive, i.e. the pre-existing folder granularity). That is the compat
 * fallback for fixtures that set only `DEVPRO_RELEVANT_ARCHIVES`. The fallback
 * direction is safe: it checks MORE, so its failure mode is false red, which
 * is the same direction the guard already errs in.
 */
const TOUCHED_ARCHIVE_SPEC_PATH_RE =
  /^openspec\/changes\/archive\/[^/]+\/specs\/[^/]+\/spec\.md$/;

function getTouchedArchiveSpecPaths(cwdArg) {
  if (process.env.DEVPRO_TOUCHED_ARCHIVE_SPECS !== undefined) {
    return new Set(
      process.env.DEVPRO_TOUCHED_ARCHIVE_SPECS
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
    );
  }
  if (process.env.DEVPRO_RELEVANT_ARCHIVES !== undefined) {
    // Compat fallback: fixtures that inject the relevance set but not the
    // carrier set keep folder granularity, unchanged (NFR5).
    return null;
  }
  return new Set(
    probeArchiveRelevance(cwdArg).paths.filter((entry) =>
      TOUCHED_ARCHIVE_SPEC_PATH_RE.test(entry),
    ),
  );
}

// Probe the current branch once; reused by the gate (a) rules-lane exemption
// below and could serve future branch-aware checks. Uses the inline
// RULES_BRANCH_RE above (SSOT-locked to lib/branch-naming.mjs, same regex as
// the gate-(i) exemption + cross-model gate + validateRulesBranch).
let currentBranch = '';
try {
  const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' });
  if (r.status === 0) currentBranch = (r.stdout || '').trim();
} catch {}
const isRulesBranch = currentBranch !== '' && RULES_BRANCH_RE.test(currentBranch);

/**
 * The set of active (non-archive) change folder names under openspec/changes/
 * that this branch's diff *touches* — i.e. created or modified relative to
 * origin/main. Used by gate (a) so that pre-existing active change folders
 * inherited from main (other PRs' legitimately in-progress multi-phase work)
 * do NOT block this PR; only a change folder this branch actually worked on
 * (and failed to archive) blocks (issue #848 follow-up: blanket readdir blocked
 * every feature PR in repos that keep multiple in-progress changes on main).
 *
 * Resolution mirrors getRelevantArchives:
 *   1. DEVPRO_DIFF_ACTIVE_CHANGES env var (comma-separated; tests / override).
 *      Empty string → empty set.
 *   2. git diff --name-only origin/main...HEAD -- openspec/changes/ , keeping
 *      only the first path segment under changes/ that is NOT `archive`.
 *   3. git unavailable / fails → empty array (so we fall back to branch-suffix
 *      ownership alone; never blanket-block on inherited WIP).
 */
function getDiffTouchedActiveChanges(cwdArg) {
  if (process.env.DEVPRO_DIFF_ACTIVE_CHANGES !== undefined) {
    return process.env.DEVPRO_DIFF_ACTIVE_CHANGES
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const result = spawnSync(
    'git',
    ['-C', cwdArg, 'diff', '--name-only', 'origin/main...HEAD', '--', 'openspec/changes/'],
    { encoding: 'utf8' }
  );
  // git unavailable / origin/main unresolvable (shallow clone, no remote) →
  // return [] (same fail-open convention as getRelevantArchives). Ownership
  // then falls back to branch-suffix matching alone; a change folder whose name
  // differs from the branch suffix would not be detected as owned in this
  // degraded case. Accepted because (1) the repo enforces three-way name
  // alignment (change name = branch suffix), so the suffix signal normally
  // covers the owned change, and (2) the real PR-creation context (CI /
  // /devpro:pre-pr) always has origin/main, so issue #170's "archive your current
  // change first" protection is not weakened in practice.
  if (result.error || result.status !== 0) {
    addEffectiveScopeAdvisory(
      `active change relevance probe degraded: git diff origin/main...HEAD failed; ` +
      `branch-suffix ownership fallback only; first failure: ${firstFailureLine(result)}.`
    );
    return [];
  }
  const folders = new Set();
  for (const line of result.stdout.split('\n')) {
    const m = line.match(/^openspec\/changes\/([^\/]+)\//);
    if (m && m[1] !== 'archive') folders.add(m[1]);
  }
  return Array.from(folders);
}

/**
 * Return the set of change names already archived on origin/main's tree.
 * Used by gate (a) to exclude inherited residual folders that origin/main has
 * already renamed into archive/ — so they are NOT treated as blocking violations
 * for this branch (issue #1031).
 *
 * Resolution order (mirrors getDiffTouchedActiveChanges / getRelevantArchives):
 *   1. DEVPRO_MAIN_ARCHIVED_NAMES env var — comma-separated change names.
 *      Used by tests (fixtures lack git history) and as a manual override.
 *      Empty string → empty set (no names archived on main).
 *   2. Probe origin/main tree: first confirm `git rev-parse origin/main^{commit}`
 *      resolves (fail-open if not), then list `git ls-tree origin/main
 *      openspec/changes/archive/` and extract <name> from `archive/<date>-<name>/`
 *      entries.
 *   3. git unavailable / origin/main unresolvable → return [] (fail-open, per D5).
 *      Fail-open: inherited-residual exclusion is an additive enhancement; when
 *      the probe fails we fall back to the pre-fix behaviour (block if owned),
 *      which does NOT weaken the issue #170 own-change protection.
 *
 * NOTE: intentionally fail-open (unlike gate (i) which is fail-closed after a
 * successful rev-parse). This helper only adds exclusions; failure → no exclusions
 * → existing block behaviour preserved.
 */
function getMainArchivedChangeNames(cwdArg) {
  if (process.env.DEVPRO_MAIN_ARCHIVED_NAMES !== undefined) {
    return process.env.DEVPRO_MAIN_ARCHIVED_NAMES
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  // Step 1: confirm origin/main resolves (fail-open if not)
  const revParse = spawnSync(
    'git',
    ['-C', cwdArg, 'rev-parse', 'origin/main^{commit}'],
    { encoding: 'utf8' }
  );
  if (revParse.error || revParse.status !== 0) return [];

  // Step 2: list tree entries under archive/
  const lsTree = spawnSync(
    'git',
    ['-C', cwdArg, 'ls-tree', '--name-only', 'origin/main', 'openspec/changes/archive/'],
    { encoding: 'utf8' }
  );
  if (lsTree.error || lsTree.status !== 0) return [];

  const names = [];
  for (const line of lsTree.stdout.split('\n')) {
    // Entries look like: openspec/changes/archive/2026-05-01-some-name/
    // or just: 2026-05-01-some-name  (depending on git ls-tree output format)
    // Extract the final path segment (strip trailing slash)
    const segment = line.trim().replace(/\/$/, '');
    const folderName = segment.split('/').pop();
    if (!folderName) continue;
    // Archive folder format: <YYYY-MM-DD>-<name> — extract <name> (everything after first date prefix)
    const nameMatch = folderName.match(/^\d{4}-\d{2}-\d{2}-(.+)$/);
    if (nameMatch) names.push(nameMatch[1]);
  }
  return names;
}

// Run before every OpenSpec pass-through so rule-carrier scope and objective
// measurement are independent of archive existence, relevance, and proposal
// contents. Function declarations below are hoisted deliberately.
const ruleTokenManifest = runObjectiveRuleTokenGate(cwd);

// (a) Active change check
let activeChanges = [];
try {
  activeChanges = readdirSync(changesDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name !== 'archive')
    .map(d => d.name);
} catch {
  // openspec/changes/ doesn't exist — nothing to gate, pass-through
  passArchiveGate('no openspec/changes dir — nothing to gate');
}

// Rules-lane exemption (issue #848): `rules/<source>-v<X.Y.Z>` branches per
// rules-flow.md § Dedicated Rules Branch base off the anchor SHA (not
// origin/main), so the working tree inherits whatever active change folders
// exist on the anchor base. A rules sync commit physically cannot create or
// modify openspec/changes/ (not in SYNC_DIRS per sync-agent-rules.mjs), so
// blocking on those pre-existing folders is a false positive — exactly the
// case-(i) rules-lane exemption rationale (issue #784).
//
// IMPORTANT: this suppresses only the (a) *block*; it does NOT early-exit the
  // script. (a) is the first of (a)-(i); a rules branch with a promoted archive
  // must still flow through (b)-(h) so it reaches a token-emitting passArchiveGate
  // that prints the `archived as '<name>'` evidence for `/devpro:pre-pr` / PR body
  // audit trails (cross-model PR #841 I5 contract; covered by
// pre-pr-archive-gate.test.mjs case 19). On a rules branch the terminal exit is
// gate (i)'s own rules self-skip `passArchiveGate(..., latest)` (it also exempts
// rules branches and fires before the bottom `'archived & promoted'` exit) —
// either way the token is emitted; the contract is on the token, not which exit.
//
// Scope-bound active-change check (issue #848 follow-up): only block on a change
// folder THIS branch owns — one this branch's diff touched, or one matching the
// branch suffix — not on every folder under openspec/changes/. Repos that keep
// multiple in-progress multi-phase changes on main legitimately inherit other
// PRs' active folders in the working tree; blanket-blocking on them deadlocked
// every feature PR (the change's own folder may already be archived). This
// preserves issue #170's protection: the current change must be archived before
// PR — but only the current change, not unrelated inherited WIP.
const branchSuffix = currentBranch.includes('/')
  ? currentBranch.slice(currentBranch.indexOf('/') + 1)
  : currentBranch;
const diffTouchedActive = new Set(getDiffTouchedActiveChanges(cwd));
const ownedActiveChanges = activeChanges.filter(
  (name) => diffTouchedActive.has(name) || name === branchSuffix
);
// Issue #1031: exclude inherited residual folders — active copies that origin/main
// has already renamed into archive/. Gate (a) can still treat these as owned via
// the branch-suffix fallback or explicit env override. But git will resolve this
// automatically on merge (main-side rename wins); no action needed.
const mainArchived = new Set(getMainArchivedChangeNames(cwd));
const inheritedArchivedResidual = ownedActiveChanges.filter((n) => mainArchived.has(n));
// A folder holding only the gitignored lite batch scope record (`proven-lite`) is
// not an un-archived change: a lite batch never archives. The shared classifier
// is the single shape check; every other verdict keeps the folder blocking.
const ownedClassification = new Map(
  ownedActiveChanges
    .filter((n) => !mainArchived.has(n))
    .map((n) => [n, classifyExistingBrdDirectory(path.join(changesDir, n))])
);
const provenLiteOwned = [...ownedClassification]
  .filter(([, verdict]) => verdict.reason === 'proven-lite')
  .map(([name]) => name);
const blockingOwned = ownedActiveChanges.filter((n) => !mainArchived.has(n) && !provenLiteOwned.includes(n));
// Codes worth naming in the (a) failure so the author sees why a lite-looking
// folder still blocks; every other blocking folder is an ordinary un-archived change.
const liteShapeCodes = blockingOwned
  .map((n) => [n, ownedClassification.get(n)?.code])
  .filter(([, code]) => code === 'lite-scope-with-proposal' || code === 'artifact-class-unknown');

// Informational (stdout, non-blocking): report inherited residuals that are
// already archived on origin/main and will resolve automatically on merge.
// Per D4: four required elements — folder name / inherited+already archived /
// will resolve on merge / no action needed. Must NOT emit the rescue hint.
if (inheritedArchivedResidual.length > 0) {
  process.stdout.write(
    `Pre-PR archive gate: inherited active change folder(s) ${inheritedArchivedResidual.join(', ')} already archived on origin/main` +
    ` — will resolve automatically on merge (no action needed).\n`
  );
}

if (provenLiteOwned.length > 0) {
  process.stdout.write(
    `Pre-PR archive gate: active change folder(s) ${provenLiteOwned.join(', ')} are proven-lite` +
    ` — they hold only the untracked lite batch scope record (lite-scope.md) and have nothing to archive.\n`
  );
}

if (midBatch && blockingOwned.length > 0) {
  process.stdout.write(
    `Pre-PR archive gate: --mid-batch skipped check (a); remaining active: ${blockingOwned.join(', ')}. This is not the final pre-PR gate.\n`
  );
}

if (blockingOwned.length > 0 && !isRulesBranch && !midBatch && !preReview) {
  process.stderr.write(
    `Pre-PR archive gate: Active change folder still exists: ${blockingOwned.join(', ')}\n` +
    `\n` +
    `These change folders belong to the current branch (matched the branch suffix\n` +
    `or this branch's diff) but are not yet archived.\n` +
    `\n` +
    `If <name> matches your current branch suffix (normal pre-archive state):\n` +
    `  Run \`openspec archive <name> -y\` first, then re-run /devpro:pre-pr.\n` +
    `\n` +
    `If <name> is leftover from a merged prior PR (rare; missed archive recovery):\n` +
    `  Open a separate rescue branch \`chore/docs-archive-<name>-recovery\` per\n` +
    `  openspec-step-1-to-9.md §Post-merge Archive Recovery (with decisions.md\n` +
    `  recovery-rationale). Do NOT fix the leftover in the current branch.\n` +
    `\n` +
    `(Active change folders inherited from main but NOT touched by this branch's\n` +
    `diff are other PRs' in-progress work and do not block this PR.)\n` +
    (liteShapeCodes.length > 0
      ? `\nFolder shape not provable as an archivable change or a proven-lite record: ` +
        `${liteShapeCodes.map(([name, code]) => `${name} (${code})`).join(', ')}\n`
      : '')
  );
  process.exit(1);
}

// `--pre-review` runs before the reviewer dispatch, so the review can be the last
// step before archive (decisions.md D34 / R12). It asserts only the checks whose
// inputs already exist pre-archive; everything archive-dependent stays in the
// post-archive run.
if (preReview) {
  // Lazy because normal/post-archive mode does not consume review receipts.
  // Keeping the evidence family outside that import graph also keeps archive-
  // only hook fixtures and consumer copies from acquiring unrelated runtime
  // dependencies merely by loading this script.
  const { verifyCurrentCrossCarrierClosure } = await import('./review-remediation-evidence.mjs');
  // Do not derive reviewer-owned changes only from `Dirent.isDirectory()`.
  // That filter intentionally gives the ordinary archive gate a list of real
  // active directories, but it would erase an owned symlink/non-directory
  // before the BRD classifier can reject the unsafe topology. The branch
  // suffix and diff-owned names are therefore classified first; proven chore A
  // is the only missing-folder shape that is removed from later keyed checks.
  const preReviewCandidates = new Set([...ownedActiveChanges, ...diffTouchedActive]);
  if (!isRulesBranch) preReviewCandidates.add(branchSuffix);
  const preReviewOwnedChanges = [];
  for (const name of preReviewCandidates) {
    const verdict = classifyOwnedChangeBrd({ repoRoot: cwd, changeId: name });
    if (!verdict.ok) {
      const detail = verdict.code === 'proposal-carrier-ambiguous'
        ? 'proposal-carrier-ambiguous: proposal carrier class is unknown because proposal.md and proposal-mini.md both exist'
        : verdict.code === 'lite-scope-with-proposal'
          ? 'lite-scope-with-proposal: lite-scope.md and a proposal carrier coexist, so the batch-approval carrier is not unique; ' +
            'a change promoted from lite to full MUST delete lite-scope.md and carry the batch approval in the proposal\'s ## Batch Approval Ledger ' +
            '(or delete the proposal if the change stays lite)'
          : verdict.code === 'brd-missing'
            ? 'required brd.md is missing in its entirety'
            : verdict.code === 'brd-headings-missing'
              ? `brd.md is missing required headings:\n${verdict.missing.map((heading) => `  - ${heading}`).join('\n')}`
              : `${verdict.code}: artifact class or carrier cannot be proven`;
      process.stderr.write(
        `Pre-PR archive gate (j): active change ${name} failed the BRD 12-heading assertion: ${detail}.\n` +
        `Only an exact proposal-mini.md-only B-mini carrier is BRD N/A for an existing active change.\n`
      );
      process.exit(1);
    }
    if (verdict.reason === 'proven-lite') {
      process.stdout.write(`Pre-PR archive gate: ${name} Touch coverage N/A (lite has no proposal).\n`);
    }
    if (verdict.reason === 'proven-chore-a' || verdict.reason === 'proven-lite') continue;
    preReviewOwnedChanges.push(name);
    if (verdict.applicability === 'not-applicable') {
      process.stdout.write(`Pre-PR archive gate (j): active change ${name} is ${verdict.reason}; BRD is explicitly N/A.\n`);
    }
  }
  const activeProposalBody = (name) => {
    for (const fname of proposalCandidates) {
      const candidate = path.join(changesDir, name, fname);
      if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
    }
    return null;
  };

  // R10 / design.md D10 — content-correcting active-OpenSpec lints before
  // reviewer dispatch. Distinct from `--baseline-ref` (archive/PR relevance).
  // Runs immediately after the owned full/B-mini set is resolved so a bad
  // ADDED/MODIFIED delta fails closed before topology/currency success output
  // can be mistaken for dispatch permission.
  if (preReviewOwnedChanges.length > 0) {
    const changeBaseRef = cliChangeBaseRef;
    if (changeBaseRef === null || changeBaseRef === undefined || String(changeBaseRef).length === 0) {
      process.stderr.write(
        `Pre-PR archive gate: --pre-review with owned active full/B-mini change(s) ` +
        `(${preReviewOwnedChanges.join(', ')}) requires --change-base-ref <immutable-base>.\n` +
        `This is the worktree/change immutable base for lint-modified-scenario-preservation, ` +
        `lint-delta-body-canonical-wrap and lint-requirement-count-ratchet. MUST NOT substitute ` +
        `--baseline-ref, HEAD, or any ` +
        `implicit ref.\n`,
      );
      process.exit(1);
    }
    if (!isSafeArchiveRelevanceRef(changeBaseRef)) {
      process.stderr.write(
        `Pre-PR archive gate: --change-base-ref shape invalid: ${JSON.stringify(changeBaseRef)}\n` +
        `Fail-closed.\n`,
      );
      process.exit(1);
    }
    requireResolvableArchiveRelevanceRef(cwd, changeBaseRef, '--change-base-ref');

    const scriptsDir = path.dirname(process.argv[1] || '');
    const contentLints = [
      { id: 'lint-delta-requirement-mode', rel: 'lint-delta-requirement-mode.mjs', extra: [], short: 'requirement-mode' },
      {
        id: 'lint-modified-scenario-preservation',
        short: 'scenario-preservation',
        rel: 'lint-modified-scenario-preservation.mjs',
        extra: ['--base', changeBaseRef],
      },
      {
        id: 'lint-delta-body-canonical-wrap',
        short: 'delta-body-canonical-wrap',
        rel: 'lint-delta-body-canonical-wrap.mjs',
        extra: ['--base', changeBaseRef],
      },
      { id: 'lint-proposal-tasks-checked', rel: 'lint-proposal-tasks-checked.mjs', extra: [], short: 'proposal-tasks-checked' },
      { id: 'lint-proposal-touch-self-path', rel: 'lint-proposal-touch-self-path.mjs', extra: [], short: 'proposal-touch-self-path' },
      { id: 'lint-proposal-touch-coverage', rel: 'lint-proposal-touch-coverage.mjs',
        extra: ['--base', getArchiveRelevanceBaseline(cwd)], short: 'proposal-touch-coverage' },
      {
        id: 'lint-requirement-count-ratchet',
        short: 'requirement-count-ratchet',
        rel: 'lint-requirement-count-ratchet.mjs',
        extra: ['--base', changeBaseRef],
      },
      // Source-maintainer-only: a consumer's specs may cite its own documents in
      // the same `leaf.md` §heading form, and that shape never constrained a consumer.
      { id: 'lint-delta-spec-citations', rel: 'lint-delta-spec-citations.mjs', extra: [], sourceOnly: true, short: 'delta-spec-citations' },
    ];
    const isConsumerRepo = repoIdentity.identity === 'consumer';
    const lintsToRun = contentLints.filter((lint) => !(lint.sourceOnly && isConsumerRepo));
    const skippedLints = contentLints.filter((lint) => lint.sourceOnly && isConsumerRepo);
    for (const changeName of preReviewOwnedChanges) {
      const changeFolder = path.join('openspec', 'changes', changeName);
      for (const lint of lintsToRun) {
        const scriptPath = path.join(scriptsDir, lint.rel);
        const result = spawnSync(
          process.execPath,
          [scriptPath, changeFolder, ...lint.extra],
          { cwd, encoding: 'utf8' },
        );
        if (result.error || result.status !== 0) {
          const detail = firstFailureLine(result);
          const stderrText = String(result?.stderr || '');
          const unavailable = isActiveContentLintUnavailable(detail, stderrText);
          process.stderr.write(
            `Pre-PR archive gate: active content lint failed before reviewer dispatch.\n` +
            `  lint   : ${lint.id}\n` +
            `  change : ${changeName}\n` +
            `  detail : ${detail}\n` +
            activeContentLintRemediationText({ unavailable }),
          );
          process.exit(1);
        }
      }
    }
    process.stdout.write(
      `Active content lints asserted for ${preReviewOwnedChanges.join(', ')}: ` +
      `${lintsToRun.map((lint) => lint.short).join(', ')} ` +
      `(R10; --change-base-ref ${changeBaseRef}).\n`,
    );
    for (const lint of skippedLints) {
      process.stdout.write(
        `Pre-PR archive gate: consumer repository — skipping ${lint.short} (source-maintainer-only content lint) for ${preReviewOwnedChanges.join(', ')}; ` +
        `consumer specs may cite their own documents in the same form, so this citation shape is not enforced there.\n`,
      );
    }
  }

  // #2985 — the bugfix prove-it task check (gate (l)) also runs here against the
  // ACTIVE change folders. Its inputs already exist pre-archive; checking it only
  // after the archive meant a missing marker surfaced after three sealed review
  // rounds, and the fix would break the archive-is-a-pure-rename premise. Same
  // branch condition and same carrier scan as gate (l); non-bugfix branches skip.
  const proveItBranch = process.env.DEVPRO_CURRENT_BRANCH !== undefined
    ? process.env.DEVPRO_CURRENT_BRANCH
    : currentBranch;
  if (proveItBranch.startsWith('bugfix/') && preReviewOwnedChanges.length > 0) {
    for (const changeName of preReviewOwnedChanges) {
      assertProveItTaskLedger({
        branch: proveItBranch,
        folderAbs: path.join(changesDir, changeName),
        folderLabel: 'active change folder',
        displayPath: path.join('openspec/changes', changeName),
        trailer: '這是 --pre-review 的提前檢查（與歸檔後 gate (l) 同一判定）：缺標記要在 reviewer dispatch 之前補上，否則封存後才發現會多一輪審查。\n',
      });
    }
    process.stdout.write(
      `Bugfix prove-it task asserted for ${preReviewOwnedChanges.join(', ')}: an existing task-ledger carrier has a prove-it marker (#2985; same check as gate (l)).\n`,
    );
  }

  evaluateSourceGovernance(preReviewOwnedChanges.map(activeProposalBody).filter((body) => body !== null));

  // R6 / design.md D16 — the regression-head currency assertion.
  //
  // The six-axis reviewer is the last step before archive, so this is the last
  // place a mechanical check can still run for free. Dispatching a reviewer
  // against a tree the canonical suite has never covered buys a review round
  // whose findings a green suite would have produced first, which is exactly
  // the zero-value round notes item `## 107.` documents.
  //
  // Deliberately NOT a new numbered item in `/devpro:pre-pr` Step 3.0 and NOT a
  // fifth lint command (D16): `--pre-review` already resolves
  // `ownedActiveChanges`, and a receipt keyed by change name is the same set of
  // already-known inputs read one directory over.
  const currentHeadSha = (() => {
    const probe = spawnSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    return probe.status === 0 ? String(probe.stdout ?? '').trim() : '';
  })();
  // Every owned change is asserted, not just the first: a branch owning two
  // active changes that reads only one receipt would pass while the second
  // change's suite was never run at this HEAD.
  //
  // R1 / design.md D1 (fix-consumer-pre-pr-gates): the canonical suite and its
  // pass/fail=0/digest receipt are source-maintainer artifacts. A consumer
  // repository is never held to them — the loop is not entered and no receipt
  // is read; the named skip replaces the R6 summary line below. `unknown` keeps
  // this fail-closed assertion unchanged.
  const uncoveredHeads = repoIdentity.identity === 'consumer'
    ? []
    : preReviewOwnedChanges
      .map((name) => evaluateRegressionHeadCurrency({ cwd, change: name, currentHeadSha }))
      .filter((verdict) => !verdict.ok);
  if (uncoveredHeads.length > 0) {
    const describe = (verdict) => {
      if (verdict.kind === 'stale') return 'HEAD moved after the suite was recorded green';
      if (verdict.kind === 'missing') return 'no receipt — an unrecorded suite run is not evidence about this tree';
      return `receipt cannot be trusted: ${verdict.reason}`;
    };
    process.stderr.write(
      `Pre-PR archive gate: the canonical test suite has not been recorded green at the current HEAD.\n` +
      `\n` +
      uncoveredHeads.map((verdict) =>
        `  change "${verdict.change}": ${describe(verdict)}\n` +
        `    tested HEAD : ${verdict.testedSha || '(none recorded)'}\n` +
        `    current HEAD: ${verdict.currentSha || '(unresolvable)'}\n` +
        `    receipt     : ${verdict.recordPath}\n`
      ).join('\n') +
      `\n` +
      `The six-axis reviewer is the last step before archive. Reviewing a tree the\n` +
      `suite has not covered spends a full round re-finding what a green suite would\n` +
      `have reported first.\n` +
      `\n` +
      `Run the canonical suite, then record which HEAD it covered (suite_evidence flags required):\n` +
      `  node .devpro/scripts/run-test-suite.mjs --changed main\n` +
      uncoveredHeads.map((verdict) =>
        `  node .devpro/scripts/record-regression-head.mjs --change ${verdict.change} --suite-status pass --suite-fail 0 --suite-digest <suite_digest_sha256-from-runner-output>\n`
      ).join('')
    );
    process.exit(1);
  }

  // R8 / design.md D24-D25 — the latest open reviewer finding set must be
  // mechanically closed before another reviewer sees the tree. Semantic
  // discovery remains reviewer-owned; this gate only replays the bounded fixed
  // literal set the remediation record declares and exact-covers every hit in
  // current-HEAD tracked regular text blobs.
  const closureVerdicts = preReviewOwnedChanges.map((name) => {
    try {
      return verifyCurrentCrossCarrierClosure({ repoRoot: cwd, changeId: name });
    } catch (error) {
      return {
        ok: false,
        status: 'invalid-closure-authority',
        change: name,
        reason: error.message,
      };
    }
  });
  const unclosedFindings = closureVerdicts.filter((verdict) => !verdict.ok);
  if (unclosedFindings.length > 0) {
    process.stderr.write(
      `Pre-PR archive gate: cross-carrier remediation closure is missing, stale, ambiguous, or invalid.\n\n` +
      unclosedFindings.map((verdict) =>
        `  change "${verdict.change}": ${verdict.status}\n` +
        `    reason: ${verdict.reason}\n`
      ).join('\n') +
      `\nSeal exact classification and current-HEAD declared-literal coverage before reviewer dispatch:\n` +
      `  node .devpro/scripts/review-remediation-evidence.mjs seal-cross-carrier-closure --request <json-file>\n` +
      `\nThis gate proves coverage of the declared search set; it is not a generic semantic oracle.\n`
    );
    process.exit(1);
  }

  // Issue #2526 / dry-ssot-corpus P3 — named-definition corpus-grep evidence must
  // land before six-axis review. Cooperative declaration only; no diff oracle.
  const {
    evaluateNamedDefCorpusGrepEvidence,
    NAMED_DEF_CORPUS_GREP_EVIDENCE_HEADING,
  } = await import('./lib/named-def-corpus-grep-evidence.mjs');
  const corpusGrepGaps = preReviewOwnedChanges.map((name) => {
    const body = activeProposalBody(name);
    const verdict = evaluateNamedDefCorpusGrepEvidence(body);
    return { change: name, ...verdict };
  }).filter((verdict) => !verdict.ok);
  if (corpusGrepGaps.length > 0) {
    process.stderr.write(
      `Pre-PR archive gate: named-definition corpus-grep evidence is missing or incomplete before reviewer dispatch.\n\n` +
      corpusGrepGaps.map((verdict) =>
        `  change "${verdict.change}": ${verdict.code}\n` +
        `    reason: ${verdict.reason}\n` +
        (Array.isArray(verdict.missingDefinitions) && verdict.missingDefinitions.length > 0
          ? `    definitions needing evidence: ${verdict.missingDefinitions.join(', ')}\n`
          : '')
      ).join('\n') +
      `\nNext action: add ## ${NAMED_DEF_CORPUS_GREP_EVIDENCE_HEADING} with a \`\`\`json fence\n` +
      `  status "none" + reason, or status "present" + definitions[{name,scope,hits|results,disposition}].\n` +
      `Cite dry-ssot-corpus.md P3. This gate does not regex-judge whether a symbol is a named definition.\n`
    );
    process.exit(1);
  }

  // R6 summary slot: source and unknown keep the satisfied line (or the
  // no-owned-change shape); a consumer repository prints the named skip —
  // design.md D1 full text, deliberately NOT shaped like "already satisfied".
  const regressionHeadSummary = preReviewOwnedChanges.length === 0
    ? `No owned active change, so no regression-head receipt is keyed to assert (R6) — the rules-branch / chore-A shape, not a skipped check.\n`
    : repoIdentity.identity === 'consumer'
      ? `Pre-PR archive gate: consumer repository — skipping the source-maintainer canonical-suite regression-head receipt assertion (R6).\n` +
        `  identity : consumer (${repoIdentity.evidence})\n` +
        `  changes  : ${preReviewOwnedChanges.join(', ')}\n` +
        `  reason   : the canonical suite and its pass/fail=0/digest receipt are source-maintainer-only; notes/qa-regression-head-<change>.json is not required in a consumer repository.\n` +
        `  evidence : consumer test evidence is carried by the project-agreed test command, PR Test Evidence, consumer CI, and six-axis axis 4.\n`
      : `Regression-head receipt asserted for ${preReviewOwnedChanges.join(', ')}: the canonical suite currency is ok at HEAD ${currentHeadSha} (R6; exact HEAD or bookkeeping tip-move).\n`;

  process.stdout.write(
    `Pre-PR archive gate: --pre-review asserted the archive-independent source-governance topology (e) against the active change proposal` +
    `${preReviewOwnedChanges.length > 0 ? ` (${preReviewOwnedChanges.join(', ')})` : ' (no owned active change)'}.\n` +
    regressionHeadSummary +
    `${preReviewOwnedChanges.length > 0
      ? `Cross-carrier remediation closure asserted for ${preReviewOwnedChanges.join(', ')}: latest open receipt findings are exact-covered at current HEAD or no closure is required (R8).\n`
      : `No owned active change, so no cross-carrier remediation closure is keyed to assert (R8).\n`}` +
    `${preReviewOwnedChanges.length > 0
      ? `Named-definition corpus-grep evidence asserted for ${preReviewOwnedChanges.join(', ')}: ## ${NAMED_DEF_CORPUS_GREP_EVIDENCE_HEADING} is complete (status none|present; #2526).\n`
      : `No owned active change, so no named-definition corpus-grep evidence is keyed to assert (#2526).\n`}` +
    `Archive-dependent checks — (a) active folder, (d) issue anchors, (g) dedup audit, (h) spec drift, (i) scenario preservation, promotion completeness — still run in the post-archive gate.\n`
  );
  process.exit(0);
}

// (b)/(c) setup — diff-scoped to PR-touched relevant archives (issue #959)
const archiveDir = path.join(changesDir, 'archive');
if (!existsSync(archiveDir)) {
  passArchiveGate('no archive dir yet');
}

const archives = readdirSync(archiveDir, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name)
  .sort();

if (archives.length === 0) {
  passArchiveGate('no archives yet');
}

const latest = archives[archives.length - 1];
const relevantArchives = getRelevantArchives(cwd);
const relevantExistingArchives = relevantArchives
  .filter((name) => archives.includes(name))
  .sort();
const evidenceArchive = relevantExistingArchives.length > 0
  ? relevantExistingArchives[relevantExistingArchives.length - 1]
  : latest;
compactnessArchiveName = evidenceArchive;

// Compute the set of archives to evaluate for checks (b) and (c):
// diff-scoped to the archives this PR touches (relevantExistingArchives).
// An empty relevant set evaluates zero archives so unrelated historical debt
// in the latest archive does not block this PR (issue #1847).
const bcEvalArchives = relevantExistingArchives;

// The `## Batch Approval Ledger` sub-check inside (c) is narrower than
// bcEvalArchives: it only applies to archives this PR newly ADDED
// (getAddedArchives), not every archive bcEvalArchives merely touches. A PR
// that edits some unrelated file inside a pre-existing historical archive
// (e.g. a docs backfill) must not be blocked by that archive predating this
// requirement and lacking a ledger — see decisions.md "T12 後覆核" C1 fix.
// `## Why`/`## What Changes` stay scoped to the full bcEvalArchives set
// (pre-existing behavior, unchanged).
const ledgerEvalArchives = new Set(getAddedArchives(cwd));

// (c) Proposal headings check (issue #386) — diff-scoped to bcEvalArchives.
//     openspec archive emits non-blocking warning if proposal.md lacks
//     `## Why` / `## What Changes`, AND fails to generate openspec/specs/<cap>/spec.md.
//     We backstop with hard block here, since the missing spec is a silent
//     functional regression that breaks the next change's baseline diff.
//     Scope-bound to relevantExistingArchives per issue #1847 (mirrors the
//     (d)/(e)/(g) pattern); an empty relevant set skips this check.
for (const archiveName of bcEvalArchives) {
  for (const fname of proposalCandidates) {
    const p = path.join(archiveDir, archiveName, fname);
    if (existsSync(p)) {
      const body = readFileSync(p, 'utf8');
      const hasWhy = /^## Why\s*$/m.test(body);
      const hasWhat = /^## What Changes\s*$/m.test(body);
      // enforce-batch-scope-ledger-presence (design.md D1): two independent
      // failure branches, NOT one composite check. Branch 1 (heading absent)
      // shares the existing missingHeadings array/message/exit path with
      // `## Why`/`## What Changes` — byte-identical for those two. Branch 2
      // (heading present but shape !== 'ok') is a distinct failure mode with
      // its own message, kept out of missingHeadings so the two rationales
      // (missing generation input vs. incomplete audit trail) are not diluted
      // into one blended sentence.
      const ledgerCheckApplies = ledgerEvalArchives.has(archiveName);
      // Forced to 'ok' when the check doesn't apply, so the two branches
      // below can test `ledgerShape` alone without repeating `ledgerCheckApplies &&`.
      const ledgerResult = ledgerCheckApplies
        ? evaluateBatchApprovalLedgerShape(body, { archiveName })
        : 'ok';
      // Every verdict is a string except `legacy`, which also carries the
      // offending tokens as written in the ledger (remove-second-review-disclosure-approval D3).
      const ledgerShape = typeof ledgerResult === 'string' ? ledgerResult : ledgerResult.verdict;
      if (!hasWhy || !hasWhat || ledgerShape === 'absent') {
        const missingHeadings = [
          !hasWhy ? '## Why' : null,
          !hasWhat ? '## What Changes' : null,
          ledgerShape === 'absent' ? '## Batch Approval Ledger' : null,
        ].filter(Boolean).join(' / ');
        const specGenerationNote = (!hasWhy || !hasWhat)
          ? `Without \`## Why\`/\`## What Changes\`, openspec archive does NOT generate openspec/specs/<cap>/spec.md.\n` +
            `Fix: add \`## Why\` and \`## What Changes\` to ${fname}, re-run \`openspec archive\`, commit.\n`
          : '';
        const ledgerFixNote = ledgerShape === 'absent'
          ? `Fix (Batch Approval Ledger): add a \`## Batch Approval Ledger\` H2 with a structured ledger, or write ` +
            `\`N/A: no batch approval selected\` if stepwise mode was used, then re-run \`openspec archive\`, commit.\n`
          : '';
        process.stderr.write(
          `Pre-PR archive gate (c): Archive ${archiveName}/${fname} missing required heading(s): ${missingHeadings}\n` +
          `\n` +
          specGenerationNote +
          ledgerFixNote +
          `Reference: .devpro/agent-rules/proposal-template.md\n`
        );
        process.exit(1);
      }
      if (ledgerShape === 'shapeless') {
        process.stderr.write(
          `Pre-PR archive gate (c): Archive ${archiveName}/${fname} has a '## Batch Approval Ledger' section ` +
          `that is present but incomplete — neither the \`N/A: no batch approval selected\` sentinel nor a ` +
          `structurally complete ledger (kind / named_change / branch / repo_scope / non-empty covers / an excludes key).\n` +
          `\n` +
          `An empty or partially-filled ledger cannot stand in for the actual Batch Scope Confirmation outcome ` +
          `recorded during /devpro:change 第零步.\n` +
          `Fix: fill in the full ledger per the template, or write \`N/A: no batch approval selected\` if stepwise ` +
          `mode was used, then re-run \`openspec archive\`, commit. The only valid \`kind\` is ` +
          `\`same-change-dp-change-batch\`; express a narrower custom scope via \`excludes\`, not a custom \`kind\` value.\n` +
          `Reference: .devpro/agent-rules/proposal-template.md\n`
        );
        process.exit(1);
      }
      if (ledgerShape === 'legacy') {
        // Only archives this PR newly adds reach here (ledgerEvalArchives): historical archives that
        // still carry retired ledger items are never re-validated or rewritten.
        process.stderr.write(
          `Pre-PR archive gate (c): openspec/changes/archive/${archiveName}/${fname} Batch Approval Ledger has retired ` +
          `ledger item(s) \`${ledgerResult.tokens.join(', ')}\`. ` +
          `Remove only those item(s) from the active proposal's ledger before archiving ` +
          `(block list: delete just the \`- <item>\` lines; flow list: delete just those names, keep the rest); ` +
          `if this branch already archived it, follow openspec-step-1-to-9.md pre-merge re-archive. ` +
          `A retired ledger item is no longer part of the ledger and can simply be deleted (retired item; delete it).` +
          `${legacyExcludesNotice(ledgerResult.excluded_tokens)}\n`
        );
        process.exit(1);
      }
      break; // first existing proposal file wins for this archive
    }
  }
}

// (b) Capability spec promote check — diff-scoped to bcEvalArchives.
//     Per issue #1847: iterate every relevant archive and evaluate zero
//     archives when the relevant set is empty.
//     Per-archive chore-A pass-through: if an archive has no specs/ dir,
//     skip that archive (it is a legitimate chore-A change with no spec delta).
//     The overall no-spec pass-through remains after independent and lifecycle
//     checks so an empty scope cannot bypass gates unrelated to archives.
let anySpecsFound = false;
for (const archiveName of bcEvalArchives) {
  const specsDir = path.join(archiveDir, archiveName, 'specs');
  if (!existsSync(specsDir)) {
    // This archive has no spec delta — chore-A pattern for this archive, skip.
    continue;
  }
  anySpecsFound = true;
  const caps = readdirSync(specsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
  const missing = [];
  for (const cap of caps) {
    const canonical = path.join(cwd, 'openspec/specs', cap, 'spec.md');
    if (!existsSync(canonical)) {
      missing.push(cap);
    }
  }
  if (missing.length > 0) {
    process.stderr.write(
      `Pre-PR archive gate: Capability spec not promoted: ${missing.join(', ')} — re-run \`openspec archive\`\n`
    );
    process.exit(1);
  }
}

function normalizePromotedSpecLine(line) {
  return line
    .trim()
    .replace(/^[-*]\s+/, '')
    .replace(/^>\s+/, '')
    .replace(/^#{1,6}\s+/, '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isIgnorableSpecLine(trimmed, normalized) {
  return (
    normalized === '' ||
    /^```/.test(trimmed) ||
    /^\|?[-:\s|]+\|?$/.test(trimmed)
  );
}

function isNormativeSpecLine(normalized) {
  return /\b(SHALL|MUST|SHOULD|MAY)\b/i.test(normalized) || /必須|應該|應|不得|禁止/.test(normalized);
}

function collectPromotedSpecAssertions(deltaBody) {
  const assertions = [];
  const seen = new Set();
  let inPromotedRequirements = false;
  let currentScenarioTitle = null;

  function add(kind, text, scenarioTitle = null) {
    const normalized = normalizePromotedSpecLine(text);
    if (!normalized) return;
    // Include scenarioTitle so identical normative lines under different
    // scenarios stay distinct (GH-2508 WARN: Removed A then retained B with
    // the same body must not drop B when A is exemption-skipped).
    const key = `${kind}:${scenarioTitle ?? ''}:${normalized}`;
    if (seen.has(key)) return;
    seen.add(key);
    assertions.push({ kind, normalized, scenarioTitle });
  }

  for (const rawLine of deltaBody.split('\n')) {
    const trimmed = rawLine.trim();
    const requirementSection = trimmed.match(/^##\s+(.+?)\s*$/);
    if (requirementSection) {
      inPromotedRequirements = /^(ADDED|MODIFIED)\s+Requirements\b/i.test(requirementSection[1]);
      currentScenarioTitle = null;
      continue;
    }
    if (!inPromotedRequirements) continue;

    const requirement = trimmed.match(/^### Requirement:\s*(.+?)\s*$/);
    if (requirement) {
      currentScenarioTitle = null;
      add('Requirement heading', `Requirement: ${requirement[1]}`);
      continue;
    }

    const scenario = trimmed.match(/^#### Scenario:\s*(.+?)\s*$/);
    if (scenario) {
      currentScenarioTitle = scenario[1];
      add('Scenario heading', `Scenario: ${scenario[1]}`, currentScenarioTitle);
      continue;
    }

    if (/^#{1,6}\s+/.test(trimmed)) continue;

    const normalized = normalizePromotedSpecLine(trimmed);
    if (isIgnorableSpecLine(trimmed, normalized) || !isNormativeSpecLine(normalized)) continue;
    add('normative body line', normalized, currentScenarioTitle);
  }

  return assertions;
}

function normalizeSpecForContainment(content) {
  return content
    .split('\n')
    .map((line) => normalizePromotedSpecLine(line))
    .filter(Boolean)
    .join('\n');
}

const relevantArchivesWithProposal = relevantExistingArchives.filter((archiveName) =>
  proposalCandidates.some((fname) => existsSync(path.join(archiveDir, archiveName, fname)))
);

// (l) Bugfix prove-it task check (issue #959 D2 check D).
// When the current branch starts with `bugfix/`, each relevant archive's
// task-ledger carrier must exist and contain at least one prove-it marker,
// indicating that a failing-test-first / prove-it task was required. The
// carrier is resolved per archive as proposal-mini.md first, else tasks.md
// (design.md D6): a compliant B-mini bugfix carries its prove-it task inline
// in proposal-mini.md's `## Tasks` section instead of authoring a separate
// tasks.md, and unconditionally requiring tasks.md previously blocked that
// compliant shape. Neither carrier present is fail-closed because otherwise
// bugfix archives can bypass the prove-it check entirely.
// Accepted markers (case-insensitive): prove-it / prove it / failing test /
// 重現.*bug  (per openspec-quality-and-formats.md §Tasks.md 品質要求（bugfix 強制項） + testing-and-qa.md).
// Non-bugfix branches: check is skipped entirely.
// Env override: DEVPRO_CURRENT_BRANCH overrides the branch name for tests.
// Shared prove-it assertion over one change folder. The post-archive run checks
// the archived folder (gate (l)); `--pre-review` checks the active folder before
// reviewer dispatch (#2985), because a missing marker found only after the
// three review rounds are sealed costs another review round (the archive commit
// must stay a pure rename of the reviewed tree).
function assertProveItTaskLedger({ branch, folderAbs, folderLabel, displayPath, trailer = '' }) {
  const proveIt = findProveItInTaskLedgerCarriers(folderAbs, DEFAULT_PROVE_IT_RE);
  const candidateNames = TASK_LEDGER_CARRIER_CANDIDATES.join(' / ');

  if (proveIt.reason === 'no-carrier') {
    process.stderr.write(
      `Pre-PR archive gate (l)：bugfix 分支 "${branch}" 的 ${folderLabel} ${displayPath} 缺少 task-ledger carrier（tasks.md 或 proposal-mini.md 皆不存在）。\n\n` +
      `Bugfix PR 必須在 tasks.md（或 B-mini 的 proposal-mini.md \`## Tasks\`）中包含至少一個「先寫能重現 bug 的 failing test」task（prove-it pattern），\n` +
      `排序先於修復 task。\n` +
      `接受的標記（case-insensitive）：prove-it / prove it / failing test / 重現…bug\n` +
      `來源規範：.devpro/agent-rules/openspec-quality-and-formats.md §Tasks.md 品質要求（bugfix 強制項）、testing-and-qa.md。\n` +
      trailer
    );
    process.exit(1);
  }

  if (!proveIt.ok) {
    process.stderr.write(
      `Pre-PR archive gate (l)：bugfix 分支 "${branch}" 的 ${folderLabel} ${displayPath} 之 task-ledger carrier(s) [${proveIt.carriersChecked.join(', ') || candidateNames}] 未包含 prove-it test task。\n\n` +
      `Bugfix PR 必須在 tasks.md（或 B-mini 的 proposal-mini.md \`## Tasks\`）中包含至少一個「先寫能重現 bug 的 failing test」task（prove-it pattern），\n` +
      `排序先於修復 task。\n` +
      `接受的標記（case-insensitive）：prove-it / prove it / failing test / 重現…bug\n` +
      `來源規範：.devpro/agent-rules/openspec-quality-and-formats.md §Tasks.md 品質要求（bugfix 強制項）、testing-and-qa.md。\n` +
      trailer
    );
    process.exit(1);
  }
}

function runBugfixProveItTaskCheck() {
  const branchForL = process.env.DEVPRO_CURRENT_BRANCH !== undefined
    ? process.env.DEVPRO_CURRENT_BRANCH
    : currentBranch;
  if (!branchForL.startsWith('bugfix/')) return;

  for (const archiveName of relevantExistingArchives) {
    assertProveItTaskLedger({
      branch: branchForL,
      // Prove-it = any existing task-ledger carrier has a marker (design D2).
      // Executable-ledger identity remains ordered-first via the same SSOT
      // module; MUST NOT reuse proposalCandidates (proposal.md-first).
      folderAbs: path.join(archiveDir, archiveName),
      folderLabel: 'archive folder',
      displayPath: path.join('openspec/changes/archive', archiveName),
    });
  }
}

runBugfixProveItTaskCheck();

// ── (d)/(e)/(g) scope-bound to the archive folders this PR's diff touches ──
// Per issue #497: previously these checks were applied to the latest archive
// only, causing PRs with unrelated scope to be blocked by pre-existing debt
// in the latest archive folder. Now they iterate `relevantArchives`; an empty
// set means this PR doesn't touch any archive → skip (d)(e)(g).

function readProposal(archiveName) {
  for (const fname of proposalCandidates) {
    const p = path.join(archiveDir, archiveName, fname);
    if (existsSync(p)) return readFileSync(p, 'utf8');
  }
  return null;
}

// B-mini archives carry proposal-mini.md (not proposal.md). Per
// chore-classification.md a B-mini change does not author the full-proposal
// sections checked by (d) Issue Anchor Verification and (g) Dedup Audit. Gate
// (e) is independent: it measures the authoritative carrier manifest before
// proposal handling. A B-mini requiring source-governance topology work must be
// re-classified as chore B and produce proposal.md.
function isBminiArchive(archiveName) {
  return (
    existsSync(path.join(archiveDir, archiveName, 'proposal-mini.md')) &&
    !existsSync(path.join(archiveDir, archiveName, 'proposal.md'))
  );
}

// (d) Issue Anchor Verification — check each relevant archive's proposal for
// ## Issue Anchor Verification heading with grep evidence.
for (const archiveName of relevantArchives) {
  if (isBminiArchive(archiveName)) continue; // B-mini exempt (see isBminiArchive)
  const proposalBody = readProposal(archiveName);
  if (proposalBody === null) continue;
  const anchorHeadingMatch = /^## Issue Anchor Verification\s*$/m.test(proposalBody);
  const afterAnchorHeading = anchorHeadingMatch
    ? proposalBody.split(/^## Issue Anchor Verification\s*$/m)[1] || ''
    : '';
  const anchorSection = afterAnchorHeading.split(/^## /m)[0];
  const hasGrepEvidence = /grep/.test(anchorSection) || /:\d+/.test(anchorSection);
  if (!anchorHeadingMatch || !hasGrepEvidence) {
    const archivePath = path.join('openspec/changes/archive', archiveName);
    process.stderr.write(
      `Issue Anchor Verification Gate (d)：archive folder ${archivePath} 之 proposal 缺 ## Issue Anchor Verification 段或內容空。` +
      `本 gate 由 chore enforce-hook-backed-rule-system-and-rationalize-ssot PR #N 引入，` +
      `應對 PR #391 reflections 中 "issue 字面照抄未驗證 current repo state" 之類錯誤` +
      `（見 git-workflow-tracking.md §Common Rationalizations）。\n`
    );
    process.exit(1);
  }
}

function failRuleCarrierScope(reason) {
  process.stderr.write(
    `Token Budget Check Gate (e) authoritative manifest：${reason}\n` +
    `Fail-closed: committed、staged、unstaged、untracked name-status probes 必須全部成功，` +
    `exact assertion 只能驗證雙向集合相等，不能取代或修復 probe。\n`
  );
  process.exit(1);
}

function parseNameStatusZ(stdout, probe) {
  const fields = String(stdout ?? '').split('\0');
  if (fields.at(-1) === '') fields.pop();
  const entries = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!NAME_STATUS_TOKEN.test(status)) {
      throw new Error(`${probe} returned invalid status ${JSON.stringify(status)}`);
    }
    if (/^[RC]/.test(status)) {
      if (index + 1 >= fields.length) throw new Error(`${probe} returned an incomplete rename/copy tuple`);
      entries.push({ status, oldPath: normalizeRepoPath(fields[index++]), newPath: normalizeRepoPath(fields[index++]), probe });
    } else {
      if (index >= fields.length) throw new Error(`${probe} returned an incomplete path tuple`);
      const repoPath = normalizeRepoPath(fields[index++]);
      entries.push({ status, oldPath: status === 'D' ? repoPath : '', newPath: status === 'D' ? '' : repoPath, probe });
    }
  }
  return entries;
}

function runRequiredGitProbe(cwdArg, probe, args, parser = parseNameStatusZ) {
  const result = spawnSync('git', ['-C', cwdArg, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr?.trim() || `exit ${result.status}`;
    throw new Error(`${probe} probe failed: ${detail}`);
  }
  return parser(result.stdout, probe);
}

function composeFinalNameStatusEntries(tracked, untracked) {
  const untrackedByPath = new Map(untracked.map((entry) => [entry.newPath, entry]));
  const entries = [];
  for (const entry of tracked) {
    if (entry.status === 'D' && untrackedByPath.has(entry.oldPath)) {
      entries.push({ status: 'M', oldPath: '', newPath: entry.oldPath, probe: 'net-final' });
      untrackedByPath.delete(entry.oldPath);
    } else {
      entries.push(entry);
    }
  }
  entries.push(...untrackedByPath.values());
  return entries;
}

function buildAuthoritativeNameStatusManifest(cwdArg) {
  if (process.env.DEVPRO_PR_TOUCHES_RULE_FILE !== undefined) {
    failRuleCarrierScope('legacy DEVPRO_PR_TOUCHES_RULE_FILE boolean override is unsupported; remove it.');
  }
  const baselineRef = 'origin/main';

  const probeErrors = [];
  const collectProbe = (probe, args, parser) => {
    try {
      return runRequiredGitProbe(cwdArg, probe, args, parser);
    } catch (error) {
      probeErrors.push(error.message);
      return [];
    }
  };

  collectProbe('worktree', ['rev-parse', '--is-inside-work-tree'], (stdout) => {
      if (stdout.trim() !== 'true') throw new Error('not inside a Git worktree');
      return [];
  });
  collectProbe('baseline', ['rev-parse', `${baselineRef}^{commit}`], () => []);
  // These four probes are independently required even though the normalized
  // manifest below is derived from one baseline-to-final tracked diff. Every
  // one is attempted before any probe failure is returned, so one failure can
  // never hide the observability result of a later required layer.
  collectProbe('committed', ['diff', '--name-status', '-z', '-M', '-C', `${baselineRef}...HEAD`, '--']);
  collectProbe('staged', ['diff', '--name-status', '-z', '-M', '-C', '--cached', '--']);
  collectProbe('unstaged', ['diff', '--name-status', '-z', '-M', '-C', '--']);
  const untracked = collectProbe('untracked', ['ls-files', '--others', '--exclude-standard', '-z'], (stdout, probe) =>
    String(stdout ?? '').split('\0').filter(Boolean).map((repoPath) => ({
      status: '?', oldPath: '', newPath: normalizeRepoPath(repoPath), probe,
    }))
  );
  if (probeErrors.length > 0) {
    return { state: 'unknown', entries: [], error: probeErrors.join('; ') };
  }

  let entries;
  try {
    const mergeBase = runRequiredGitProbe(cwdArg, 'merge-base', ['merge-base', baselineRef, 'HEAD'], (stdout, probe) => {
      const value = stdout.trim();
      if (!/^[0-9a-f]{40,64}$/i.test(value)) throw new Error(`${probe} returned invalid object id`);
      return value;
    });
    const tracked = runRequiredGitProbe(
      cwdArg,
      'net-tracked',
      ['diff', '--name-status', '-z', '-M', '-C', mergeBase, '--']
    );
    entries = composeFinalNameStatusEntries(tracked, untracked);
  } catch (error) {
    return { state: 'unknown', entries: [], error: error.message };
  }

  entries.sort((a, b) =>
    a.probe.localeCompare(b.probe) ||
    a.oldPath.localeCompare(b.oldPath) ||
    a.newPath.localeCompare(b.newPath) ||
    a.status.localeCompare(b.status)
  );
  const manifest = { state: entries.length === 0 ? 'known-empty' : 'known-nonempty', entries };
  validateExactCarrierAssertion(manifest);
  return manifest;
}

function carrierPathsFromManifest(manifest) {
  const carriers = new Set();
  for (const entry of manifest.entries) {
    if (isRuleTokenCarrier(entry.oldPath)) carriers.add(entry.oldPath);
    if (isRuleTokenCarrier(entry.newPath)) carriers.add(entry.newPath);
  }
  return carriers;
}

function validateExactCarrierAssertion(manifest) {
  if (process.env.DEVPRO_PR_TOUCHED_RULE_FILES === undefined) return;
  const rawValues = process.env.DEVPRO_PR_TOUCHED_RULE_FILES.trim() === ''
    ? []
    : process.env.DEVPRO_PR_TOUCHED_RULE_FILES.split(',');
  const asserted = new Set();
  for (const raw of rawValues) {
    const normalized = normalizeRepoPath(raw);
    if (!normalized || normalized !== raw.trim() || raw.trim().startsWith('/') || raw.trim().split('/').includes('..') || !isRuleTokenCarrier(normalized)) {
      failRuleCarrierScope(`DEVPRO_PR_TOUCHED_RULE_FILES contains invalid exact carrier path ${JSON.stringify(raw)}。`);
    }
    if (asserted.has(normalized)) failRuleCarrierScope(`DEVPRO_PR_TOUCHED_RULE_FILES repeats ${normalized}。`);
    asserted.add(normalized);
  }
  const actual = carrierPathsFromManifest(manifest);
  const missing = [...actual].filter((value) => !asserted.has(value));
  const extra = [...asserted].filter((value) => !actual.has(value));
  if (missing.length > 0 || extra.length > 0) {
    failRuleCarrierScope(
      `DEVPRO_PR_TOUCHED_RULE_FILES is not bidirectionally equal (missing=${missing.join(',') || 'none'}; extra=${extra.join(',') || 'none'})。`
    );
  }
}

function runObjectiveRuleTokenGate(cwdArg) {
  const manifest = buildAuthoritativeNameStatusManifest(cwdArg);
  if (manifest.state === 'unknown') failRuleCarrierScope(manifest.error);
  const result = measureRuleTokenBudget({ cwd: cwdArg, manifest });
  if (result.scope === 'known-empty') {
    process.stdout.write('scope=known-empty; checked=0; verdict=pass\n');
  } else {
    for (const file of result.files) {
      process.stdout.write(
        `rule-token-budget path=${file.path}; status=${file.status}; bytes=${file.bytes ?? 'deleted'}; ` +
        `tokens=${file.tokens ?? 'deleted'}; tier=${file.tier}; cap=${file.cap}; utilization=${file.utilization ?? 'deleted'}; ` +
        `registry=${file.registry}; guard=${file.guard}; reason=${file.reason}; verdict=${file.verdict}; ` +
        `semanticReview=${file.semanticReview}\n`
      );
    }
    process.stdout.write(`scope=${result.scope}; checked=${result.checked}; verdict=${result.verdict}\n`);
  }
  if (result.verdict !== 'pass') {
    process.stderr.write('Token Budget Check Gate (e)：objective carrier measurement blocked; see deterministic records above.\n');
    process.exit(1);
  }
  // Over-cap alone: soft-warn + exit 0 (integrity already fail-closed above).
  emitCapPressureSoftWarn(result.files);
  return manifest;
}

// Gates (e)/(r) consume actual bytes/tokens from the authoritative manifest.
// Proposal prose is intentionally not a machine source and semanticReview is a
// review-required signal only; this gate never emits a machine semantic verdict.
function isBoundedSourceGovernancePath(repoPath) {
  const normalized = normalizeRepoPath(repoPath);
  return normalized === 'AGENTS.md' ||
    /^\.claude\/agents\/.+/.test(normalized) ||
    /^\.devpro\/agent-skills\/.+/.test(normalized) ||
    /^\.devpro\/agent-rules\/.+/.test(normalized);
}

function boundedManifestEntries(manifest) {
  return manifest.entries.filter((entry) =>
    isBoundedSourceGovernancePath(entry.oldPath) || isBoundedSourceGovernancePath(entry.newPath)
  );
}

function classifyBoundedTopology(entries) {
  if (entries.length === 0) return { state: 'non-trigger', entries };
  const kinds = entries.map((entry) => entry.status[0]);
  if (kinds.some((kind) => kind === 'R' || kind === 'C')) return { state: 'trigger', entries };
  const deletes = kinds.filter((kind) => kind === 'D').length;
  const additions = kinds.filter((kind) => kind === 'A' || kind === '?').length;
  const modifications = kinds.filter((kind) => kind === 'M').length;
  if (deletes > 0 && additions === 0) return { state: 'trigger', entries };
  const existingSplitCandidates = deletes + modifications;
  if (existingSplitCandidates === 1 && additions >= 2) return { state: 'trigger', entries };
  if (deletes >= 2 && additions === 1) return { state: 'trigger', entries };
  if ((deletes > 0 && additions > 0) || (modifications > 0 && additions > 0)) {
    return { state: 'ambiguous', entries };
  }
  return { state: 'non-trigger', entries };
}

// `classifyRepoIdentity` / `consumerRootHasPositiveEvidence` moved verbatim to
// `./lib/repo-identity.mjs` (design.md D2 of fix-consumer-pre-pr-gates): one
// identity SSOT shared with the consumer-only delta gate. The module-level
// probe at `const repoIdentity = classifyRepoIdentity(cwd)` is unchanged.

function manifestTuple(entry) {
  return /^[RC]/.test(entry.status)
    ? `${entry.status}:${entry.oldPath}->${entry.newPath}`
    : `${entry.status}:${entry.newPath || entry.oldPath}`;
}

function resolveAmbiguousAttestation(entries, bodies) {
  const matches = bodies.flatMap((body) => [...body.matchAll(/^Source-Governance-Action:\s*(none|split|delete|merge|dedup);\s*carriers=([^;]+);\s*evidence=(.+)$/gm)]);
  if (matches.length !== 1) return { valid: false, reason: `expected one exact attestation, found ${matches.length}` };
  const [, action, carrierText, evidenceText] = matches[0];
  const expectedCarriers = new Set(entries.flatMap((entry) => [entry.oldPath, entry.newPath]).filter(isBoundedSourceGovernancePath));
  const actualCarriers = new Set(carrierText.split(',').map(normalizeRepoPath).filter(Boolean));
  const expectedEvidence = new Set(entries.map(manifestTuple));
  const actualEvidence = new Set(evidenceText.split(',').map((value) => value.trim()).filter(Boolean));
  const equal = (left, right) => left.size === right.size && [...left].every((value) => right.has(value));
  if (!equal(expectedCarriers, actualCarriers) || !equal(expectedEvidence, actualEvidence)) {
    return { valid: false, reason: 'attestation carrier/status tuples do not equal the authoritative manifest' };
  }
  return { valid: true, action, trigger: action !== 'none' };
}

// Gate (e)'s authoritative manifest is `runObjectiveRuleTokenGate` (git
// name-status vs merge-base plus untracked), so the topology verdict is
// archive-independent; only the attestation text has a carrier that differs by
// phase — the archived proposal post-archive, the active proposal in
// `--pre-review`. One function so both phases share the exact same assertion.
function evaluateSourceGovernance(attestationBodies) {
  const boundedTopology = classifyBoundedTopology(boundedManifestEntries(ruleTokenManifest));
  if (repoIdentity.identity === 'unknown' && boundedTopology.entries.length > 0) {
    failRuleCarrierScope(
      `source-governance identity unknown (${repoIdentity.evidence}); candidates=${boundedTopology.entries.map(manifestTuple).join(',')}`
    );
  }
  if (repoIdentity.identity === 'source' && boundedTopology.state === 'ambiguous') {
    const attestation = resolveAmbiguousAttestation(boundedTopology.entries, attestationBodies);
    if (!attestation.valid) failRuleCarrierScope(`ambiguous source-governance topology: ${attestation.reason}。`);
    return attestation.trigger;
  }
  return repoIdentity.identity === 'source' && boundedTopology.state === 'trigger';
}

const sourceGovernanceTriggered = evaluateSourceGovernance(
  relevantArchives.map(readProposal).filter((body) => body !== null)
);

function reportCadenceIndeterminate(reason) {
  process.stderr.write(
    `Periodic Rationalization Cadence (f): indeterminate (${reason}); advisory only — no count/reset or below-threshold claim.\n`
  );
}

// ── Batched archive-introduction index (fix-hook-gate-server-block Fix A) ──
//
// Replaces the per-archive 4×git-subprocess fan-out with three read-only
// batched walks plus in-process lookups (design.md D1–D4 of the
// fix-hook-gate-server-block change):
//   1. graph:  git rev-list --parents HEAD                      (D2 ancestry)
//   2. main:   git log --full-history --full-diff --format=%H %P
//              --name-status -z -M -C -- openspec/changes/archive/
//   3. merge:  git log --full-history --merges --format=%H %P
//              --name-status -z -m -M -C -- openspec/changes/archive/
// `--full-diff` on the main walk is load-bearing (design gate F-1-1): the
// traversal stays pathspec-limited but each record's name-status entries are
// the whole-commit set — the classifier's bounded-governance input (D/M/R/C
// entries outside the archive path) must not silently disappear.
// `--full-history` keeps per-dir add commits that default simplification
// prunes (design D3); it is NOT implied by `--full-diff` on the tested git
// version. The `-z` record grammar is pinned by design D1: header = `%H %P`
// (parentless roots may print a trailing space — trimmed before split),
// followed by `\n<status>` NUL `<path>` NUL per entry (R/C consume two path
// fields); merges are header-only records in the main walk and repeated
// per-parent records in the `-m` merge walk. Header detection is positional
// (F-fhgb-r1-03): a sha-shaped field is accepted as a header only when the
// next field continues the grammar (header / '\n'-prefixed first status /
// end of stream). Any field violating the grammar
// marks the whole batch unknown — advisory semantics fail closed at the
// "no count claim" level, matching the old "probe failed → unknown" behavior.
const CADENCE_ARCHIVE_DIR = 'openspec/changes/archive';

function isCommitHeaderField(field) {
  return /^[0-9a-f]{40,64}(?: [0-9a-f]{40,64})*$/.test(field.trim());
}

/**
 * Position-rule guard (F-fhgb-r1-03): a commit header is valid only where the
 * pinned -z grammar expects one, and its continuation must match that grammar
 * — the next field is either another header (header-only record) or the
 * '\n'-prefixed first status of this record's name-status entries (or the
 * stream ends). A sha-shaped field whose continuation is neither (e.g. a
 * 40-hex path that drifted into a status position under an unknown grammar)
 * must fail the whole batch closed instead of silently re-splitting records.
 */
function isHeaderContinuationField(field) {
  return field === undefined || isCommitHeaderField(field) || field.startsWith('\n');
}

function parseBatchedNameStatusWalk(stdout, probe) {
  const fields = String(stdout ?? '').split('\0');
  if (fields.length > 0 && fields.at(-1) === '') fields.pop();
  const records = [];
  let current = null;
  for (let index = 0; index < fields.length;) {
    const field = fields[index];
    if (isCommitHeaderField(field)) {
      if (!isHeaderContinuationField(fields[index + 1])) {
        throw new Error(`${probe} returned a sha-shaped field where an entry was expected`);
      }
      const parts = field.trim().split(/\s+/);
      current = { sha: parts[0], parents: parts.slice(1), entries: [] };
      records.push(current);
      index += 1;
      continue;
    }
    if (!current) throw new Error(`${probe} returned an entry before any commit header`);
    const status = field.startsWith('\n') ? field.slice(1) : field;
    if (!NAME_STATUS_TOKEN.test(status)) {
      throw new Error(`${probe} returned invalid status ${JSON.stringify(status)}`);
    }
    if (/^[RC]/.test(status)) {
      if (index + 2 >= fields.length) throw new Error(`${probe} returned an incomplete rename/copy tuple`);
      current.entries.push({
        status,
        oldPath: normalizeRepoPath(fields[index + 1]),
        newPath: normalizeRepoPath(fields[index + 2]),
        probe,
      });
      index += 3;
    } else {
      if (index + 1 >= fields.length) throw new Error(`${probe} returned an incomplete path tuple`);
      const repoPath = normalizeRepoPath(fields[index + 1]);
      current.entries.push({
        status,
        oldPath: status === 'D' ? repoPath : '',
        newPath: status === 'D' ? '' : repoPath,
        probe,
      });
      index += 2;
    }
  }
  return records;
}

const cadenceIndexByCwd = new Map();

function getCadenceIndex(cwdArg) {
  let index = cadenceIndexByCwd.get(cwdArg);
  if (!index) {
    index = buildCadenceIndex(cwdArg);
    cadenceIndexByCwd.set(cwdArg, index);
  }
  return index;
}

function buildCadenceIndex(cwdArg) {
  const index = {
    mainRecords: null,
    mainError: null,
    mergeRecords: null,
    mergeError: null,
    mergeBuilt: false,
    graph: null,
    graphError: null,
    graphBuilt: false,
  };
  const main = spawnSync(
    'git',
    ['-C', cwdArg, 'log', '--full-history', '--full-diff', '--format=%H %P', '--name-status', '-z', '-M', '-C', '--', CADENCE_ARCHIVE_DIR],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  if (main.error || main.status !== 0) {
    index.mainError = `git log full-history probe failed: ${main.error?.message || main.stderr?.trim() || `exit ${main.status}`}`;
  } else {
    try {
      index.mainRecords = parseBatchedNameStatusWalk(main.stdout, 'cadence-main-walk');
    } catch (error) {
      index.mainError = error.message;
    }
  }
  return index;
}

function ensureCadenceMergeWalk(cwdArg, index) {
  if (index.mergeBuilt) return;
  index.mergeBuilt = true;
  const merge = spawnSync(
    'git',
    ['-C', cwdArg, 'log', '--full-history', '--merges', '--format=%H %P', '--name-status', '-z', '-m', '-M', '-C', '--', CADENCE_ARCHIVE_DIR],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  if (merge.error || merge.status !== 0) {
    index.mergeError = `git log merge-fallback probe failed: ${merge.error?.message || merge.stderr?.trim() || `exit ${merge.status}`}`;
  } else {
    try {
      index.mergeRecords = parseBatchedNameStatusWalk(merge.stdout, 'cadence-merge-walk');
    } catch (error) {
      index.mergeError = error.message;
    }
  }
}

function ensureCadenceGraph(cwdArg, index) {
  if (index.graphBuilt) return;
  index.graphBuilt = true;
  const result = spawnSync(
    'git',
    ['-C', cwdArg, 'rev-list', '--parents', 'HEAD'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  if (result.error || result.status !== 0) {
    index.graphError = `git rev-list parent graph probe failed: ${result.error?.message || result.stderr?.trim() || `exit ${result.status}`}`;
    return;
  }
  const graph = new Map();
  for (const line of String(result.stdout ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    graph.set(parts[0], parts.slice(1));
  }
  index.graph = graph;
}

/**
 * In-process `merge-base --is-ancestor` equivalent over the D1 walk-1 parent
 * graph (design D2). Never approximates via `rev-list HEAD --not epoch`
 * membership (intro commits that are ANCESTORS of the epoch would be
 * misjudged there); graph reachability is exact.
 *
 * Correctness note: a node's verdict is complete only after ALL of its
 * parents are evaluated. The iterative DFS finishes nodes in post-order
 * (parents before the node), then evaluates bottom-up as
 * `parents.some(memo-true)` and memoizes every finished node — a naive
 * "memoize all visited as found" would label side-branch ancestors of a
 * merge with the merge's epoch verdict (false positives on side branches).
 */
function buildEpochAncestryResolver(graph, epochSha) {
  const memo = new Map([[epochSha, true]]);
  return (introSha) => {
    if (memo.has(introSha)) return memo.get(introSha);
    const order = [];
    const visiting = new Set();
    const visited = new Set();
    const stack = [introSha];
    while (stack.length > 0) {
      const sha = stack.pop();
      if (sha === epochSha) {
        memo.set(epochSha, true);
        continue; // epoch is a verdict leaf — its parents are irrelevant
      }
      if (memo.has(sha) || visited.has(sha)) continue;
      if (visiting.has(sha)) {
        // Revisit marker: all parents handled → finish this node.
        visiting.delete(sha);
        visited.add(sha);
        order.push(sha);
        continue;
      }
      visiting.add(sha);
      stack.push(sha);
      for (const parent of graph.get(sha) || []) stack.push(parent);
    }
    for (const sha of order) {
      const parents = graph.get(sha) || [];
      memo.set(sha, parents.some((parent) => memo.get(parent) === true));
    }
    return memo.get(introSha) === true;
  };
}

function isIntroductionQualifier(entry, prefix) {
  if (entry.status === 'A' || entry.status === '?') return entry.newPath.startsWith(prefix);
  if (entry.status.startsWith('R') || entry.status.startsWith('C')) return entry.newPath.startsWith(prefix);
  return false;
}

function introductionForArchive(cwdArg, index, archiveName) {
  const prefix = `${CADENCE_ARCHIVE_DIR}/${archiveName}/`;
  if (index.mainError) return { unknown: `history probe failed for ${archiveName}` };
  // pass 1 (single-parent priority, design D3): newest qualifier record with
  // exactly one parent. The rewritten squash root's snapshot qualifies for
  // hundreds of archives with a NEWER rewrite timestamp — it must never
  // shadow a real single-parent add (old per-dir behavior resolves those).
  // pass 2: only when no single-parent qualifier exists at all, the newest
  // non-single-parent qualifier (root-only dirs) stays indeterminate.
  let rootFallback = null;
  for (const record of index.mainRecords) {
    if (!record.entries.some((entry) => isIntroductionQualifier(entry, prefix))) continue;
    if (record.parents.length === 1) {
      return { sha: record.sha, entries: record.entries };
    }
    if (rootFallback === null) rootFallback = record;
  }
  if (rootFallback !== null) {
    return { unknown: `introduction commit is not unique-parent for ${archiveName}` };
  }
  // pass 3: merge walk fallback (merge-introduced dirs; per-parent -m records).
  ensureCadenceMergeWalk(cwdArg, index);
  if (index.mergeError) return { unknown: `history probe failed for ${archiveName}` };
  for (const record of index.mergeRecords) {
    if (!record.entries.some((entry) => isIntroductionQualifier(entry, prefix))) continue;
    return { unknown: `introduction commit is not unique-parent for ${archiveName}` };
  }
  return { unknown: `introduction commit missing for ${archiveName}` };
}

function loadArchiveIntroduction(cwdArg, archiveName) {
  return introductionForArchive(cwdArg, getCadenceIndex(cwdArg), archiveName);
}

function runPeriodicRationalizationCadence({ cwdArg, archiveNames, archiveDirArg, identity }) {
  if (identity.identity === 'consumer') {
    process.stdout.write('Periodic Rationalization Cadence (f): skipped (proven consumer).\n');
    return;
  }
  if (identity.identity === 'unknown') {
    reportCadenceIndeterminate(`repository identity unknown: ${identity.evidence}`);
    return;
  }

  const epochMatches = archiveNames.filter((name) => /^\d{4}-\d{2}-\d{2}-fix-consumer-check-scope$/.test(name));
  if (epochMatches.length !== 1) {
    reportCadenceIndeterminate(`v1 migration epoch expected exactly once, found ${epochMatches.length}`);
    return;
  }
  const epoch = loadArchiveIntroduction(cwdArg, epochMatches[0]);
  if (epoch.unknown) {
    reportCadenceIndeterminate(epoch.unknown);
    return;
  }

  const fullArchives = archiveNames.filter((name) =>
    name !== epochMatches[0] && existsSync(path.join(archiveDirArg, name, 'proposal.md')) &&
    !existsSync(path.join(archiveDirArg, name, 'proposal-mini.md'))
  );
  const index = getCadenceIndex(cwdArg);
  let ancestryResolver = null;
  const relevant = [];
  const unknown = [];
  for (const name of fullArchives) {
    const intro = introductionForArchive(cwdArg, index, name);
    if (intro.unknown) {
      unknown.push(intro.unknown);
      continue;
    }
    if (ancestryResolver === null) {
      ensureCadenceGraph(cwdArg, index);
      if (index.graphError) {
        unknown.push(`ancestry probe failed for ${name}`);
        break;
      }
      ancestryResolver = buildEpochAncestryResolver(index.graph, epoch.sha);
    }
    if (!ancestryResolver(intro.sha)) continue;
    const topology = classifyBoundedTopology(intro.entries.filter((entry) =>
      isBoundedSourceGovernancePath(entry.oldPath) || isBoundedSourceGovernancePath(entry.newPath)
    ));
    if (topology.state === 'ambiguous') unknown.push(`ambiguous introduction topology for ${name}`);
    else if (topology.state === 'trigger') relevant.push(name);
  }
  if (unknown.length > 0) {
    reportCadenceIndeterminate(unknown.join('; '));
    return;
  }

  const resetIndex = relevant.findLastIndex((name) => /(?:^|-)rationalize(?:-|$)/.test(name));
  const sinceRationalize = relevant.slice(resetIndex + 1);
  if (sinceRationalize.length >= 5) {
    process.stderr.write(
      `Periodic Rationalization Cadence (f)：自上次 rationalize PR 已累積 ${sinceRationalize.length} 個 chore B（≥ 5 觸發警告）。` +
      `請安排 rule corpus audit（signal 只觸發 audit，不直接建立 change）；若無 accepted finding，dry audit 不建立空 change/PR。` +
      `Per rule-audit-playbook.md §Cadence。\n`
    );
  }
}

// (f) Periodic Rationalization Cadence (warn-only, non-blocking)
runPeriodicRationalizationCadence({
  cwdArg: cwd,
  archiveNames: archives,
  archiveDirArg: archiveDir,
  identity: repoIdentity,
});

// (g) Dedup Audit check — iterate relevant archives when the authoritative
// manifest proves a definite bounded source-governance topology. It requires:
//   - ## File-Role Ledger with classification content; N/A is invalid because
//     the measured topology already proves a delete/rename/split/merge/dedup
//   - ## Dedup Audit 三步結果 with ≥ 2 of: 守則 3 / 守則 4 / token-first
// Generic proposal keywords never trigger this gate. Consumer repositories and
// manifests without bounded candidates do not require these headings or N/A.
function declaresFileRoleLedgerNotApplicable(section) {
  return section.split('\n').some((line) => {
    const normalized = line.replace(/[`*_~]/g, '').trim();
    return /^(?:File-Role Ledger\s*:\s*)?N\s*\/\s*A(?:\b|$)/i.test(normalized);
  });
}

for (const archiveName of relevantArchives) {
  if (isBminiArchive(archiveName)) continue;
  const proposalBody = readProposal(archiveName);
  if (proposalBody === null) continue;
  if (!sourceGovernanceTriggered) continue;

  const archivePath = path.join('openspec/changes/archive', archiveName);

  // ── Check ## File-Role Ledger ──────────────────────────────────────────
  const ledgerHeadingMatch = /^## File-Role Ledger\s*$/m.test(proposalBody);
  const afterLedgerHeading = ledgerHeadingMatch
    ? proposalBody.split(/^## File-Role Ledger\s*$/m)[1] || ''
    : '';
  const ledgerSection = afterLedgerHeading.split(/^## /m)[0];

  const ledgerOk = ledgerHeadingMatch &&
    !declaresFileRoleLedgerNotApplicable(ledgerSection) &&
    /true duplication|leaf-self-contained|cross-runtime fallback/i.test(ledgerSection);

  // ── Check ## Dedup Audit 三步結果 ─────────────────────────────────────
  const dedupHeadingMatch = /^## Dedup Audit 三步結果\s*$/m.test(proposalBody);
  const afterDedupHeading = dedupHeadingMatch
    ? proposalBody.split(/^## Dedup Audit 三步結果\s*$/m)[1] || ''
    : '';
  const dedupSection = afterDedupHeading.split(/^## /m)[0];

  let dedupOk = false;
  if (dedupHeadingMatch) {
    const keywords = ['守則 3', '守則 4', 'token-first'];
    const matchCount = keywords.filter((kw) => dedupSection.includes(kw)).length;
    if (matchCount >= 2) dedupOk = true;
  }

  if (!ledgerOk || !dedupOk) {
    process.stderr.write(
      `Gate G Dedup Audit (g)：authoritative manifest proves a definite source-governance topology for archive folder ${archivePath}, ` +
      `but proposal 缺有效 ## File-Role Ledger 或 ## Dedup Audit 三步結果 段（per proposal-template.md §File-Role Ledger 與 §Dedup Audit 三步結果 mandatory）。` +
      `本 gate 由 chore enforce-dedup-audit-gate-and-trim-ai-autonomy PR 引入，應對 PR #396 Commit 1 跳過 mandatory dedup audit 之 process violation 防再犯。` +
      `Definite delete/rename/split/merge/dedup 不得以 File-Role Ledger: N/A 規避；generic proposal keywords 不構成 trigger。\n`
    );
    process.exit(1);
  }
}

// Returns true only when `sha` is the commit that first introduces `relPath`.
// The current tree must contain the exact path, and no parent may contain it.
// Merge commits and any Git failure return false so they fall through to the
// normal archive-only classifier rather than receiving an unsafe exclusion.
function isArchivePathIntroduction(cwdArg, sha, relPath) {
  const runGit = (args) => {
    const result = spawnSync('git', ['-C', cwdArg, ...args], { encoding: 'utf8' });
    if (result.error || result.status !== 0) return null;
    return result.stdout;
  };
  const parentsOutput = runGit(['rev-list', '--parents', '-n', '1', sha]);
  if (parentsOutput === null) return false;
  const fields = parentsOutput.trim().split(/\s+/).filter(Boolean);
  if (fields.length < 1 || fields[0] !== sha || fields.length > 2) return false;

  const currentTree = runGit(['ls-tree', '-z', '--name-only', sha, '--', relPath]);
  if (currentTree === null || currentTree !== `${relPath}\0`) return false;
  if (fields.length === 1) return true; // root commit

  const parentTree = runGit(['ls-tree', '-z', '--name-only', fields[1], '--', relPath]);
  return parentTree !== null && parentTree.length === 0;
}

// Returns true iff every changed line `sha` introduces to `relPath` (an archive
// delta spec.md) lands strictly before the first `## ` heading — i.e. the
// commit only touched the delta preamble (title + change-description prose),
// which has no counterpart in the canonical spec and is never promoted.
// Added/modified lines are checked against the post-image heading line (the
// `+` side of the diff maps onto post-image line numbers); pure-deletion hunks
// have no post-image counterpart, so they are checked against the pre-image
// heading line using the `-` side start instead (see pure-deletion branch
// below). Returns false (the safe / non-excluding default) when the file has
// no `## ` heading at all, or when any changed/deleted line lands at/after it,
// or on any git failure — callers must treat a false return + git failure as
// "fall through to archive-only", not as proof of preamble-only-ness. Throws
// on git failure so the caller's existing fail-open `try/catch` (and
// `gitFailed` fail-open flag) still governs.
function isPreambleOnlyChange(cwdArg, sha, relPath) {
  const findFirstHeadingLine = (content) => {
    const lines = content.split('\n');
    return lines.findIndex((line) => /^## /.test(line)) + 1; // 1-based; 0 → not found
  };

  const postRes = spawnSync('git', ['-C', cwdArg, 'show', `${sha}:${relPath}`], { encoding: 'utf8' });
  if (postRes.error || postRes.status !== 0) throw new Error('git show (post-image) failed');
  const firstSectionHeadingLine = findFirstHeadingLine(postRes.stdout);
  if (firstSectionHeadingLine === 0) return false; // defensive: no `## ` heading → do not exclude

  const diffRes = spawnSync('git', ['-C', cwdArg, 'show', '--unified=0', '--format=', sha, '--', relPath], { encoding: 'utf8' });
  if (diffRes.error || diffRes.status !== 0) throw new Error('git show (diff) failed');
  const hunkHeaderRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  let sawHunk = false;
  // Lazily fetched/cached: pre-image content + its first `## ` heading line,
  // only needed when a pure-deletion hunk is actually encountered.
  let firstSectionHeadingLinePre;
  for (const line of diffRes.stdout.split('\n')) {
    const m = hunkHeaderRe.exec(line);
    if (!m) continue;
    sawHunk = true;
    const oldStart = parseInt(m[1], 10);
    const oldCount = m[2] !== undefined ? parseInt(m[2], 10) : 1;
    const newStart = parseInt(m[3], 10);
    const newCount = m[4] !== undefined ? parseInt(m[4], 10) : 1;
    // A single hunk can carry BOTH a deletion (`-` side) and an addition (`+`
    // side) — a replacement. Each side must be checked INDEPENDENTLY against its
    // own image's heading; an `if (newCount > 0) … else …` that inspects only
    // one side lets a replacement hunk whose deletion spans the heading but
    // whose addition sits in the preamble bypass the gate (cross-model review
    // PR #1497 second Critical). So: if this hunk adds lines, check the `+` span
    // against the post-image heading; if it deletes lines, check the `-` span
    // against the pre-image heading. Either span reaching at/after its heading
    // means the hunk touches Requirement-body/Scenario structure → not
    // preamble-only.
    if (newCount > 0) {
      // Added/modified lines: `+` side maps onto post-image line numbers.
      const newEnd = newStart + newCount - 1;
      if (newEnd >= firstSectionHeadingLine) return false; // `+` side touches heading or later
    }
    if (oldCount > 0) {
      // Deleted lines: `-` side maps onto pre-image line numbers, so it needs
      // the pre-image heading line (lazily fetched). A deletion span reaching
      // at/after the pre-image heading removes Requirement-body/Scenario lines.
      const oldEnd = oldStart + oldCount - 1;
      if (firstSectionHeadingLinePre === undefined) {
        const preRes = spawnSync('git', ['-C', cwdArg, 'show', `${sha}^:${relPath}`], { encoding: 'utf8' });
        if (preRes.error || preRes.status !== 0) throw new Error('git show (pre-image) failed'); // e.g. root commit, no parent
        firstSectionHeadingLinePre = findFirstHeadingLine(preRes.stdout);
      }
      if (firstSectionHeadingLinePre === 0 || oldEnd >= firstSectionHeadingLinePre) return false; // no pre-image heading, or `-` span reaches at/after it
    }
  }
  // No hunks means an empty diff for this path in this commit (should not
  // normally occur since `sha` is drawn from `git log -- relPath`) — be
  // conservative and do not exclude.
  return sawHunk;
}

function splitRawLines(buffer) {
  const lines = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0x0a) continue;
    const contentEnd = index > start && buffer[index - 1] === 0x0d ? index - 1 : index;
    lines.push({ start, end: index + 1, text: buffer.subarray(start, contentEnd).toString('utf8') });
    start = index + 1;
  }
  if (start < buffer.length) {
    const contentEnd = buffer[buffer.length - 1] === 0x0d ? buffer.length - 1 : buffer.length;
    lines.push({ start, end: buffer.length, text: buffer.subarray(start, contentEnd).toString('utf8') });
  }
  return lines;
}

function parseRawRequirementBlocks(buffer, allowedSection) {
  const lines = splitRawLines(buffer);
  const blocks = [];
  let section = '';
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index].text;
    if (/^## /.test(text)) {
      section = text;
      continue;
    }
    const requirementMatch = /^### Requirement:\s*(.+?)\s*$/.exec(text);
    if (!requirementMatch) continue;
    let next = index + 1;
    while (next < lines.length && !/^## |^### Requirement:/.test(lines[next].text)) next += 1;
    let lastNonBlank = next - 1;
    while (lastNonBlank > index && lines[lastNonBlank].text.trim() === '') lastNonBlank -= 1;
    blocks.push({
      title: requirementMatch[1],
      section,
      startLine: index + 1,
      endLine: lastNonBlank + 1,
      raw: buffer.subarray(lines[index].start, lines[lastNonBlank].end),
      allowed: section === allowedSection,
    });
    index = next - 1;
  }
  return { lines, blocks };
}

// Mechanical repair exception for a historical archive promotion that omitted
// one already-canonical complete Requirement block. This is not a
// general archive-edit permission: the commit must be a single-parent, pure
// insertion into an existing archived delta's MODIFIED section, and every new
// block must equal the same commit's unique canonical block byte-for-byte.
function isExactCanonicalRequirementBackfill(cwdArg, sha, relPath, canonicalRelPath) {
  const runGit = (args, encoding = 'utf8') => {
    const result = spawnSync('git', ['-C', cwdArg, ...args], { encoding });
    if (result.error || result.status !== 0) throw new Error(`git ${args[0]} failed`);
    return result.stdout;
  };

  try {
    const parents = runGit(['rev-list', '--parents', '-n', '1', sha]).trim().split(/\s+/);
    if (parents.length !== 2) return false;
    const parent = parents[1];
    const parentArchiveBuffer = runGit(['show', `${parent}:${relPath}`], null); // archived path must pre-exist

    const statusLines = runGit(['diff-tree', '--no-commit-id', '--name-status', '-r', parent, sha, '--', relPath])
      .split('\n').map((line) => line.trim()).filter(Boolean);
    if (statusLines.length !== 1 || statusLines[0] !== `M\t${relPath}`) return false;

    const diff = runGit(['diff', '--unified=0', parent, sha, '--', relPath]);
    const hunkHeaderRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
    const addedLines = new Set();
    let hunkCount = 0;
    for (const line of diff.split('\n')) {
      const match = hunkHeaderRe.exec(line);
      if (!match) continue;
      hunkCount += 1;
      const oldCount = match[2] === undefined ? 1 : Number.parseInt(match[2], 10);
      const newStart = Number.parseInt(match[3], 10);
      const newCount = match[4] === undefined ? 1 : Number.parseInt(match[4], 10);
      if (oldCount !== 0 || newCount <= 0) return false;
      for (let lineNumber = newStart; lineNumber < newStart + newCount; lineNumber += 1) {
        addedLines.add(lineNumber);
      }
    }
    if (hunkCount !== 1) return false;

    const archiveBuffer = runGit(['show', `${sha}:${relPath}`], null);
    const canonicalBuffer = runGit(['show', `${sha}:${canonicalRelPath}`], null);
    for (const buffer of [parentArchiveBuffer, archiveBuffer, canonicalBuffer]) {
      if (!Buffer.from(buffer.toString('utf8'), 'utf8').equals(buffer)) return false;
    }
    const parentArchive = parseRawRequirementBlocks(parentArchiveBuffer, '## MODIFIED Requirements');
    const archive = parseRawRequirementBlocks(archiveBuffer, '## MODIFIED Requirements');
    const canonical = parseRawRequirementBlocks(canonicalBuffer, '## Requirements');
    const touchedBlocks = new Set();

    for (const lineNumber of addedLines) {
      const line = archive.lines[lineNumber - 1];
      if (!line) return false;
      if (line.text.trim() === '') continue;
      const blockIndex = archive.blocks.findIndex((block) => (
        block.allowed && lineNumber >= block.startLine && lineNumber <= block.endLine
      ));
      if (blockIndex < 0) return false;
      touchedBlocks.add(blockIndex);
    }
    if (touchedBlocks.size !== 1) return false;

    const [blockIndex] = touchedBlocks;
    const block = archive.blocks[blockIndex];
    if (parentArchive.blocks.some((candidate) => candidate.title === block.title)) return false;
    if (archive.blocks.filter((candidate) => candidate.title === block.title).length !== 1) return false;

    const permittedAddedLines = new Set();
    for (let lineNumber = block.startLine; lineNumber <= block.endLine; lineNumber += 1) {
      permittedAddedLines.add(lineNumber);
      if (!addedLines.has(lineNumber)) return false;
    }
    const adjacentBlankLines = [block.startLine - 1, block.endLine + 1].filter((lineNumber) => {
      const line = archive.lines[lineNumber - 1];
      return line && line.text === '' && addedLines.has(lineNumber);
    });
    if (adjacentBlankLines.length > 1) return false;
    if (adjacentBlankLines.length === 1) permittedAddedLines.add(adjacentBlankLines[0]);
    if (addedLines.size !== permittedAddedLines.size) return false;
    for (const lineNumber of addedLines) {
      if (!permittedAddedLines.has(lineNumber)) return false;
    }

    const canonicalMatches = canonical.blocks.filter((candidate) => (
      candidate.allowed && candidate.title === block.title
    ));
    return canonicalMatches.length === 1 && block.raw.equals(canonicalMatches[0].raw);
  } catch {
    return false;
  }
}

// (h) Archive folder spec.md drift detection: post-archive-commit modification
// of openspec/changes/archive/<date>-<name>/specs/<cap>/spec.md indicates that
// archive content was edited but `openspec/specs/<cap>/spec.md` global spec
// was NOT synchronously promoted via `openspec archive`. SSOT drift risk.
//
// Heuristic (issue #848 follow-up — fix Pre-merge Archive Re-do false positive):
// classify each commit touching the archived spec.md by whether it ALSO touches
// the corresponding canonical `openspec/specs/<cap>/spec.md` in the same commit.
// A genuine promote (`openspec archive`) edits the archive delta and canonical
// together (both); a drift edit hand-touches only the archive (archive-only).
// Block iff there is BOTH an archive-only commit AND a both commit — i.e. the
// spec was promoted at some point, then later the archive copy was edited alone
// (real SSOT drift). This satisfies all three histories:
//   - Real drift (archive commit touches both + later archive-only edit) → block.
//   - Pre-merge Archive Re-do (archive → `git revert` → re-archive): every commit
//     touches both (revert un-promotes canonical, re-archive re-promotes it) →
//     zero archive-only commits → pass. The old "git log count > 1" heuristic
//     false-positived here (3 commits on the archive path > 1) even though none
//     was real drift; this gate's own message recommends that very sequence.
//   - Rename-into-archive (single rename commit, no prior canonical-coupled
//     commit) → has an archive-only commit but no both commit → pass (a missing
//     canonical there is gate (b)'s job, not drift).
//
// Path-introduction, preamble-only, and exact-canonical-backfill refinements:
// an archive path's first creation is the archive baseline, not a later
// archive-only edit, so exclude a commit only when the current tree contains
// the exact path and no parent contains it. Merge or unverifiable history falls
// through to archive-only. Before
// classifying a commit as archive-only, check whether ALL of its changed lines
// to this spec.md fall before the first `## ` heading (the delta title +
// change-description prose). That preamble region has no counterpart in the
// canonical spec and is never promoted, so hand-editing it afterward cannot
// cause SSOT drift — it is not classified archive-only (and not "both" either;
// it is simply excluded from the drift tally). A commit touching any line at or
// after the first `## ` heading (inside a `## MODIFIED`/`## ADDED Requirements`
// section) is still archive-only and still counts toward drift. A separate,
// narrower repair exception excludes only complete MODIFIED Requirement blocks
// that already exist byte-for-byte in the canonical blob at that same commit.
// Do not use --follow: normal archive commits rename active spec deltas into
// archive, and pre-archive active-path history is not archive drift.
// Scope-bound to archive folders touched by this PR, matching (d)/(e)/(g).
// Fail-open: git failures silently skipped (existing (a)/(b) checks still gate push).
{
  const archiveDirH = path.join(cwd, 'openspec/changes/archive');
  if (existsSync(archiveDirH)) {
    const drifted = [];
    for (const entry of relevantArchives) {
      const specsDir = path.join(archiveDirH, entry, 'specs');
      if (!existsSync(specsDir)) continue;
      for (const cap of readdirSync(specsDir)) {
        const specMd = path.join(specsDir, cap, 'spec.md');
        if (!existsSync(specMd)) continue;
        try {
          // git emits forward-slash paths on all platforms; normalize the
          // path.* (OS-separator) values to POSIX so the `git log` pathspec and
          // the `git show --name-only` membership test match on Windows too
          // (cross-model review: backslash vs forward-slash mismatch would make
          // every commit look archive-only and a real drift could slip / FP).
          const toPosix = (p) => p.split(path.sep).join('/');
          const relPath = toPosix(path.relative(cwd, specMd));
          const canonicalRelPath = `openspec/specs/${cap}/spec.md`;
          // Commits (newest-first) that touched the archived spec.md.
          const logRes = spawnSync(
            'git',
            ['-C', cwd, 'log', '--format=%H', '--', relPath],
            { encoding: 'utf8' }
          );
          if (logRes.error || logRes.status !== 0) continue; // fail-open
          const shas = logRes.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
          let archiveOnlyCommits = 0;
          let bothCommits = 0;
          let gitFailed = false;
          for (const sha of shas) {
            // Files this commit changed; a real promote also changes the
            // canonical spec in the same commit, a drift edit does not.
            const filesRes = spawnSync(
              'git',
              ['-C', cwd, 'show', '--name-only', '--format=', sha],
              { encoding: 'utf8' }
            );
            if (filesRes.error || filesRes.status !== 0) { gitFailed = true; break; } // fail-open
            const files = new Set(
              filesRes.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
            );
            if (files.has(canonicalRelPath)) {
              bothCommits += 1;
            } else {
              // The commit that first creates the archived path establishes
              // the archive baseline; it is not a post-archive hand-edit and
              // must not combine with a later valid paired edit into drift.
              // Only a provable root/single-parent introduction is excluded.
              if (isArchivePathIntroduction(cwd, sha, relPath)) continue;
              // Preamble-only refinement: a commit whose changes to this
              // spec.md fall entirely before the first `## ` heading has no
              // canonical counterpart and is not drift — skip counting it
              // (neither archive-only nor both) rather than falling through.
              let preambleOnly;
              try {
                preambleOnly = isPreambleOnlyChange(cwd, sha, relPath);
              } catch { gitFailed = true; break; } // fail-open
              const canonicalBackfill = !preambleOnly && isExactCanonicalRequirementBackfill(
                cwd,
                sha,
                relPath,
                canonicalRelPath
              );
              if (!preambleOnly && !canonicalBackfill) archiveOnlyCommits += 1;
            }
          }
          // Drift = the spec was promoted (a both-commit exists) AND later the
          // archive copy was edited alone (an archive-only commit exists).
          if (!gitFailed && archiveOnlyCommits > 0 && bothCommits > 0) {
            drifted.push({ archiveEntry: entry, cap, specPath: relPath, commitCount: archiveOnlyCommits });
          }
        } catch {} // git failures → skip (fail-open)
      }
    }

    if (drifted.length > 0) {
      process.stderr.write(
        `Pre-PR archive gate (h)：archive folder 內 spec.md 偵測到 post-archive-commit 修改（SSOT drift 嫌疑）：\n` +
        drifted.map(d => `  - ${d.specPath}（${d.commitCount} 個只改 archive 未同步 canonical 的 commit）`).join('\n') +
        `\n\n直接編輯 archive 內 spec.md 不會 promote 到 \`openspec/specs/<cap>/spec.md\`。Procedure（per \`openspec-archive-principles.md\` Pre-merge Archive Re-do）：\n` +
        `  (1) \`git revert <archive-commit>\` 還原 folder 為 active\n` +
        `  (2) 在 active folder 改 spec deltas\n` +
        `  (3) \`openspec archive <name>\` 重跑\n` +
        `  (4) \`git push\`\n\n` +
        `（本 gate 只算「改 archive spec.md 但同 commit 未改對應 canonical spec」的 commit；正常 archive / revert / re-archive 會同步改 canonical 故不計入。）\n` +
        `例外：若只改非 spec-delta 檔（brd / proposal prose / decisions / tasks / qa-test-scope），可在 archive folder 內直接編輯——本 gate 只看 spec.md 路徑，不擋其他檔。\n` +
        `另一例外：archive spec.md 首個 \`## \` heading 之前的 preamble/敘述段（delta 標題、change 描述 prose）也可直接校正——該區 canonical 無對應行、不會 drift；但 \`## MODIFIED\`/\`## ADDED Requirements\` section 內的 Requirement body / Scenario 仍須走上述 Pre-merge Archive Re-do。\n` +
        `分類例外：archive path 的可證明初次建立（current tree 有 exact path 且無 parent 含該 path）是 baseline，不算 post-archive drift；merge 或無法驗證時不套用。歷史修復另只排除 single-parent、既存 archive path、單一 pure-add hunk，且新增內容恰為一個 parent 未有、archive 與同 commit canonical 各自唯一、raw bytes 完全相同的完整 \`## MODIFIED Requirements\` block（最多一個相鄰空白行）。這些 classifier 都不是 author 直改 archive 的授權；任一 Git／UTF-8／唯一性／完整性驗證失敗，該 commit 仍按 archive-only 計算。\n`
      );
      process.exit(1);
    }
  }
}

// (p) Archive promotion completeness assertion — scope-bound to
// relevantExistingArchives AND, within those, to the archive spec carriers this
// PR actually touches (getTouchedArchiveSpecPaths). Empty relevant set skips
// this check so historical debt in untouched archives cannot block unrelated
// PRs; the carrier-level narrowing extends that same principle one level down,
// so editing a non-spec file inside an archive no longer inherits that whole
// archive's promotion backlog (defect A / PR #2744, blocked by deleting one
// trailing blank line in an unrelated file). The fail-closed criteria and every
// message field below are unchanged — only the MATERIAL is narrowed. Runs after
// (h), so a direct post-archive spec edit still receives the more precise drift
// message.
// GH-2508: honors `## Removed Scenarios` (same SSOT as gate (i)) and skips
// normative body lines for archives not in getAddedArchives; Requirement/
// Scenario headings remain checked unless Removed-exempt.
{
  const addedArchives = new Set(getAddedArchives(cwd));
  const touchedSpecPaths = getTouchedArchiveSpecPaths(cwd);
  // NFR2: the granularity actually used MUST be visible, otherwise "gate
  // passed" and "gate passed because it evaluated zero carriers" look identical
  // and the compat fallback to folder granularity is invisible.
  //
  // Suppressed when there are no relevant archives at all: check (p)'s loop
  // never runs in that case regardless of granularity, so the granularity is
  // not decision-relevant, and the pre-existing `scope=known-empty; checked=0`
  // line already reports it. Emitting here would also contradict the
  // established contract that a clean fixture prints no advisory (case 4c).
  if (relevantExistingArchives.length > 0) {
    addEffectiveScopeAdvisory(
      touchedSpecPaths === null
        ? 'check (p) material: archive-folder granularity (compat fallback: ' +
          'DEVPRO_RELEVANT_ARCHIVES set without DEVPRO_TOUCHED_ARCHIVE_SPECS); ' +
          `relevant archives=${relevantExistingArchives.length}.`
        : 'check (p) material: spec-carrier granularity; ' +
          `touched archive spec.md paths=${touchedSpecPaths.size}` +
          `${touchedSpecPaths.size === 0 ? ' (check (p) evaluates zero carriers)' : ''}.`,
    );
  }
  const removedDeclared = new Set();
  for (const archiveName of relevantExistingArchives) {
    for (const title of collectRemovedScenarios(path.join(archiveDir, archiveName))) {
      removedDeclared.add(title);
    }
  }
  const activeChangesDir = path.join(cwd, 'openspec/changes');
  if (existsSync(activeChangesDir)) {
    for (const entry of readdirSync(activeChangesDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'archive') continue;
      for (const title of collectRemovedScenarios(path.join(activeChangesDir, entry.name))) {
        removedDeclared.add(title);
      }
    }
  }

  const missingPromotions = [];

  // Red path only (fix-archive-promotion-check-rewrites): a range that holds
  // both an archive and a later merged PR rewriting that canonical spec (e.g.
  // `--baseline-ref <previous production tag>` on a release) used to report
  // every rewritten line as "not promoted". An assertion absent from HEAD
  // canonical is accepted only when the archived spec's adding commit is on
  // origin/main, the canonical spec at the origin/main first-parent commit
  // where it landed contained the assertion, and origin/main's canonical no
  // longer does (the rewrite already landed on main; a removal made only on
  // this branch still fails). Any git failure keeps the fail-closed report.
  const rewrittenAfterLanding = [];
  const landingEvidence = new Map();
  let mainlineFirstParents;
  const gitText = (args) => {
    const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return r.status === 0 ? r.stdout : null;
  };
  // `merge-base --is-ancestor`: 0 = ancestor, 1 = not an ancestor; any other
  // status is a failed query (null), which must void the landing evidence —
  // treating it as "not an ancestor" would let the binary search skip the real
  // landing and pick a later commit where the assertion was repaired.
  const ancestry = (ancestor, descendant) => {
    const { status } = spawnSync('git', ['-C', cwd, 'merge-base', '--is-ancestor', ancestor, descendant]);
    return status === 0 ? true : status === 1 ? false : null;
  };
  function landedCanonicalEvidence(archivedSpecRelPath, cap) {
    if (landingEvidence.has(archivedSpecRelPath)) return landingEvidence.get(archivedSpecRelPath);
    let evidence = null;
    const addSha = (gitText(['log', '--diff-filter=A', '--format=%H', '-1', 'HEAD', '--', archivedSpecRelPath]) || '').trim();
    if (addSha && ancestry(addSha, 'origin/main') === true) {
      mainlineFirstParents ??= (gitText(['rev-list', '--first-parent', '--reverse', 'origin/main']) || '')
        .split('\n').filter(Boolean);
      // Containment is monotonic along the first-parent chain, so the oldest
      // commit containing addSha (binary search) is where the archive landed.
      let lo = 0;
      let hi = mainlineFirstParents.length - 1;
      let landing = null;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const contains = ancestry(addSha, mainlineFirstParents[mid]);
        if (contains === null) {
          landing = null;
          break;
        }
        if (contains) {
          landing = mainlineFirstParents[mid];
          hi = mid - 1;
        } else {
          lo = mid + 1;
        }
      }
      const canonicalRelPath = `openspec/specs/${cap}/spec.md`;
      const landedText = landing ? gitText(['show', `${landing}:${canonicalRelPath}`]) : null;
      const mainlineText = gitText(['show', `origin/main:${canonicalRelPath}`]);
      if (landedText !== null && mainlineText !== null) {
        evidence = {
          sha: landing,
          landed: normalizeSpecForContainment(landedText),
          mainline: normalizeSpecForContainment(mainlineText),
        };
      }
    }
    landingEvidence.set(archivedSpecRelPath, evidence);
    return evidence;
  }

  for (const archiveName of relevantExistingArchives) {
    const isNewArchive = addedArchives.has(archiveName);
    const specsDir = path.join(archiveDir, archiveName, 'specs');
    if (!existsSync(specsDir)) continue;
    const caps = readdirSync(specsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    for (const cap of caps) {
      const archivedSpecRelPath =
        `openspec/changes/archive/${archiveName}/specs/${cap}/spec.md`;
      if (touchedSpecPaths !== null && !touchedSpecPaths.has(archivedSpecRelPath)) {
        continue;
      }
      const archivedSpecPath = path.join(specsDir, cap, 'spec.md');
      const canonicalSpecPath = path.join(cwd, 'openspec/specs', cap, 'spec.md');
      if (!existsSync(archivedSpecPath) || !existsSync(canonicalSpecPath)) continue;

      const assertions = collectPromotedSpecAssertions(readFileSync(archivedSpecPath, 'utf8'));
      if (assertions.length === 0) continue;

      const canonicalSearch = normalizeSpecForContainment(readFileSync(canonicalSpecPath, 'utf8'));
      for (const assertion of assertions) {
        if (assertion.scenarioTitle && removedDeclared.has(assertion.scenarioTitle)) {
          continue;
        }
        if (!isNewArchive && assertion.kind === 'normative body line') {
          continue;
        }
        if (!canonicalSearch.includes(assertion.normalized)) {
          const landed = landedCanonicalEvidence(archivedSpecRelPath, cap);
          if (
            landed &&
            landed.landed.includes(assertion.normalized) &&
            !landed.mainline.includes(assertion.normalized)
          ) {
            rewrittenAfterLanding.push(`${archiveName}@${landed.sha.slice(0, 9)}`);
            continue;
          }
          missingPromotions.push({
            archiveName,
            cap,
            kind: assertion.kind,
            text: assertion.normalized,
          });
        }
      }
    }
  }

  if (rewrittenAfterLanding.length > 0) {
    addEffectiveScopeAdvisory(
      `check (p): ${rewrittenAfterLanding.length} assertion(s) absent from HEAD canonical were ` +
      `present at the origin/main landing commit of their archive and are already gone from ` +
      `origin/main (later rewrite, not missing promotion): ${[...new Set(rewrittenAfterLanding)].join(', ')}.`,
    );
  }

  if (missingPromotions.length > 0) {
    const shown = missingPromotions.slice(0, 20);
    const extra = missingPromotions.length > shown.length
      ? `\n  ... and ${missingPromotions.length - shown.length} more missing promoted assertion(s)`
      : '';
    process.stderr.write(
      `Pre-PR archive gate (p)：archived spec delta content was not fully promoted to canonical specs.\n` +
      shown.map((m) =>
        `  - ${m.archiveName}/specs/${m.cap}/spec.md missing ${m.kind}: ${m.text}`
      ).join('\n') +
      extra +
      `\n\n` +
      `Fix: re-run \`openspec archive\` or manually promote the missing Requirement/Scenario/body text to \`openspec/specs/<cap>/spec.md\`, then re-run this gate.\n`
    );
    process.exit(1);
  }
}

// (n) Promoted spec archive placeholder gate (issue #1218).
// For each PR-touched relevant archive with a specs/<cap>/ subdirectory,
// read the canonical openspec/specs/<cap>/spec.md and check for the literal
// placeholder phrase `TBD - created by archiving` that openspec archive
// inserts into the ## Purpose block.  A hit means the author never filled in
// the Purpose after archiving — exit 1.
//
// Design constraints (per proposal.md D1–D6):
//   - grep pattern is the complete phrase (NOT bare "TBD") to avoid false
//     positives on legitimate standalone TBD annotations in other specs.
//   - scope-bound to relevantArchives (same `for … of relevantArchives` pattern
//     as (d)/(e)/(g)/(h)); empty set → skip (fail-open, additive gate).
//   - reads canonical openspec/specs/<cap>/spec.md, NOT the archive delta
//     (placeholder only exists in canonical, confirmed by issue anchor grep).
//   - physical placement: after (h), before (j) (nearest-neighbor with (h):
//     both iterate relevantArchives + read canonical path).
{
  const archiveDirN = path.join(cwd, 'openspec/changes/archive');
  if (existsSync(archiveDirN)) {
    for (const archiveName of relevantArchives) {
      const specsDir = path.join(archiveDirN, archiveName, 'specs');
      if (!existsSync(specsDir)) continue; // chore-A archive: no specs → skip
      const caps = readdirSync(specsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
      for (const cap of caps) {
        const canonicalSpec = path.join(cwd, 'openspec/specs', cap, 'spec.md');
        if (!existsSync(canonicalSpec)) continue; // not yet promoted — (b) already guards this
        const content = readFileSync(canonicalSpec, 'utf8');
        // Scope grep to ## Purpose section only (per self-reference fix: non-Purpose sections
        // may contain the literal phrase as part of gate documentation).
        // Pattern mirrors (e) Token Budget section extraction.
        const purposeSplit = content.split(/^## Purpose\s*$/m);
        if (purposeSplit.length < 2) continue; // no ## Purpose section → skip (fail-open)
        const purposeSection = purposeSplit[1].split(/^## /m)[0];
        if (purposeSection.includes('TBD - created by archiving')) {
          // Find line number scoped to the Purpose section to avoid false offset
          // when the literal phrase appears in a later non-Purpose section first.
          // purposeSplit[0] ends with the last line before "## Purpose"; its
          // split('\n').length gives the 1-based line number of "## Purpose" itself.
          // purposeSplit[1] starts with '\n' (the char after the matched heading),
          // so purposeRelIdx 0 = that blank separator, 1 = first content line, etc.
          const purposeStartLine = purposeSplit[0].split('\n').length; // 1-based line of "## Purpose"
          const purposeLines = purposeSection.split('\n');
          const purposeRelIdx = purposeLines.findIndex((l) => l.includes('TBD - created by archiving'));
          const lineNum = purposeStartLine + purposeRelIdx;
          const relPath = `openspec/specs/${cap}/spec.md`;
          process.stderr.write(
            `Pre-PR archive gate (n)：canonical spec ${relPath} 的 ## Purpose 仍是 archive placeholder（line ${lineNum}）。\n` +
            `\n` +
            `原因：\`openspec archive\` 自動在 ## Purpose 填入 placeholder，須作者手動回填真實內容後再 push。\n` +
            `\n` +
            `修正：\n` +
            `  1. 開啟 \`${relPath}\`\n` +
            `  2. 將 ## Purpose 的 \`TBD - created by archiving ...\` 行替換為真實 Purpose 描述\n` +
            `  3. 重新 commit + push（若 archive 已完成，直接改 canonical 即可，不需重跑 openspec archive）\n` +
            `\n` +
            `回填 Purpose 後此 gate (n) 即通過。\n`
          );
          process.exit(1);
        }
      }
    }
  }
}

// (j) BRD applicability and required fields check (issue #959 D2 check A).
// Active pre-review and archived paths use the same validator. An existing
// change directory with neither proposal carrier is artifact-class-unknown;
// chore A is N/A only when the active path is ENOENT and no archive exists.
{
  for (const archiveName of relevantExistingArchives) {
    const verdict = validateRequiredBrd(path.join(archiveDir, archiveName));
    if (!verdict.ok) {
      const archivePath = path.join('openspec/changes/archive', archiveName);
      const detail = verdict.code === 'proposal-carrier-ambiguous'
        ? 'proposal-carrier-ambiguous: proposal.md and proposal-mini.md both exist; artifact class is unknown'
        : verdict.code === 'brd-missing'
          ? 'brd.md 整檔缺失'
          : verdict.code === 'brd-headings-missing'
            ? `brd.md 缺少以下必填欄位：\n${verdict.missing.map((m) => `  - ${m}`).join('\n')}`
            : `${verdict.code}：artifact class 或 carrier 無法證明`;
      process.stderr.write(
        `Pre-PR archive gate (j)：archive folder ${archivePath} BRD 驗證失敗：${detail}\n\n` +
        `BRD 必填欄位（12 欄）來源：.devpro/agent-rules/openspec-quality-doc-formats.md §brd.md。\n` +
        `僅 proposal-mini.md-only 的 proven B-mini carrier 可為 N/A；修正後重新 archive。\n`
      );
      process.exit(1);
    }
    if (verdict.applicability === 'not-applicable') {
      process.stdout.write(`Pre-PR archive gate (j)：archive folder ${archiveName} 為 ${verdict.reason}；BRD 明確 N/A。\n`);
    }
  }
}

// (k) New agent-rule .md files must have an AGENTS.md index entry (issue #959
// D2 check C-1). A new rule leaf that is never referenced in AGENTS.md will
// never be loaded on-demand and its guidance is effectively dead.
//
// Source of new rule leaves: `git diff --name-only --diff-filter=A
// origin/main...HEAD -- '.devpro/agent-rules/*.md'`.
// Env override: DEVPRO_NEW_RULE_LEAVES (comma-separated basenames without .md)
// for tests / manual override. Git unavailable / origin/main unresolvable →
// fail-open (empty list, no block).
{
  let newRuleLeaves = [];

  if (process.env.DEVPRO_NEW_RULE_LEAVES !== undefined) {
    // Test / manual override: comma-separated basenames without .md extension.
    newRuleLeaves = process.env.DEVPRO_NEW_RULE_LEAVES
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  } else {
    // Production path: use git diff to find newly-added .devpro/agent-rules/*.md.
    const diffResult = spawnSync(
      'git',
      ['-C', cwd, 'diff', '--name-only', '--diff-filter=A', 'origin/main...HEAD',
        '--', '.devpro/agent-rules/'],
      { encoding: 'utf8' }
    );
    if (!diffResult.error && diffResult.status === 0) {
      for (const line of diffResult.stdout.split('\n')) {
        const trimmed = line.trim();
        // Only .devpro/agent-rules/<leaf>.md (single-level, no subdirectory)
        const m = trimmed.match(/^\.devpro\/agent-rules\/([^/]+)\.md$/);
        if (m) newRuleLeaves.push(m[1]); // basename without .md
      }
    }
    // git unavailable / diff fails → newRuleLeaves stays [] → fail-open (no block)
  }

  if (newRuleLeaves.length > 0) {
    const agentsMdPath = path.join(cwd, 'AGENTS.md');
    let agentsMdBody = '';
    if (existsSync(agentsMdPath)) {
      agentsMdBody = readFileSync(agentsMdPath, 'utf8');
    }

    // Narrow the search to the "觸發式載入索引" section of AGENTS.md.
    // Searching the full file risks a false-positive when a leaf name appears
    // in prose/comments outside the index table (under-enforcement: gate passes
    // even though the leaf is not on-demand-loadable).
    //
    // Algorithm:
    //   1. Find the line `## 觸發式載入索引` (the section header).
    //   2. Extract text from that header to the next `## ` header (or EOF).
    //   3. Search within that extracted section only.
    //
    // Fail-safe: if the section header is not found (e.g. AGENTS.md was
    // restructured), fall back to searching the entire file so the gate does
    // not hard-block all new-rule PRs due to a structural mismatch.
    let searchBody = agentsMdBody; // fail-safe default: full file
    const sectionHeaderRe = /^## 觸發式載入索引\s*$/m;
    const headerMatch = sectionHeaderRe.exec(agentsMdBody);
    if (headerMatch) {
      // Start of section content (character after the header line).
      const sectionStart = headerMatch.index + headerMatch[0].length;
      const afterSection = agentsMdBody.slice(sectionStart);
      // Find the next `## ` header within the remainder.
      const nextHeaderMatch = /^## /m.exec(afterSection);
      searchBody = nextHeaderMatch
        ? afterSection.slice(0, nextHeaderMatch.index)
        : afterSection;
    } else {
      // Structural fallback — note in stderr so it's visible during CI runs.
      process.stderr.write(
        `Pre-PR archive gate (k)：AGENTS.md 無「## 觸發式載入索引」section header，` +
        `退回搜整檔（fail-open）。\n`
      );
    }

    // Match `<leaf>.md` using a word-boundary regex — AGENTS.md indexes leaves
    // as `` `<leaf>.md` ``. A simple substring includes() has two failure modes:
    //   1. bare-basename: `flow` ⊂ `workflow` (resolved by adding `.md`)
    //   2. suffix-collision: `flow.md` ⊂ `openspec-flow.md` (the current bug)
    // Word-boundary pattern (?<![\w-])<escaped>.md(?![\w-]) fixes both:
    //   - `flow.md` does NOT match `openspec-flow.md` (preceding char is `-`)
    //   - `flow.md` does NOT match `flow-helper.md` (trailing char is `-`)
    //   - `flow.md` DOES match backtick/space/table-cell delimited entries
    // Leaf names are kebab-case; only `.` needs escaping in the regex body.
    const missing = newRuleLeaves.filter((leaf) => {
      const escapedLeaf = leaf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(?<![\\w-])${escapedLeaf}\\.md(?![\\w-])`);
      return !re.test(searchBody);
    });

    // 1-hop reachability fallback — mirrors agents-md-index-mapping.test.mjs's
    // 1-hop expansion so the two reachability definitions stay aligned.
    //
    // A de-bundled sibling leaf may not appear directly in the AGENTS.md index
    // section but IS reachable when an indexed entry leaf references it via a
    // explicit Load-chain declaration (e.g. `Load-chain: see \`foo-sibling.md\``).
    // The direct-text
    // check above would incorrectly block such a sibling.
    //
    // Algorithm (synchronous, matching the readFileSync style of this file):
    //   1. Gather entry leaves named in the index section text (backtick refs
    //      of the form `<name>.md`).
    //   2. For each leaf still missing, check whether any entry leaf's .md file
    //      declares the missing leaf on a line-anchored Load-chain line.
    //   3. If any entry leaf declares the missing leaf → 1-hop covered → drop.
    //   TRUE orphans (no direct index entry AND no entry-leaf declaration) still
    //   fail the gate.
    if (missing.length > 0) {
      // Step 1: collect all leaf basenames mentioned via backticks in TABLE ROWS
      // of the index section only (lines starting with `|` that are not separator
      // rows). Anchor extraction is limited to table rows to match
      // agents-md-index-mapping.test.mjs (note-line entries are not valid
      // 1-hop anchors).
      const tableRowLines = searchBody
        .split('\n')
        .filter((line) => line.startsWith('|') && !/^\|\s*-+/.test(line));
      const entryLeafRe = /`([^`/]+\.md)`/g;
      const entryLeaves = new Set();
      for (const line of tableRowLines) {
        for (const m of line.matchAll(entryLeafRe)) {
          const name = m[1].trim();
          if (!name.includes('*') && !name.includes('/')) {
            entryLeaves.add(name.replace(/\.md$/, ''));
          }
        }
      }

      const rulesDir = path.join(cwd, '.devpro', 'agent-rules');

      const resolveDeclaredRootLeaf = (ref) => {
        const normalized = ref.trim();
        if (normalized.includes('*')) return null;
        if (normalized.startsWith('.devpro/agent-rules/')) {
          return path.basename(normalized, '.md');
        }
        if (!normalized.includes('/')) return normalized.replace(/\.md$/, '');
        return null;
      };

      // Step 2: for each still-missing leaf, test 1-hop coverage.
      const stillMissing = missing.filter((leaf) => {
        for (const entryLeaf of entryLeaves) {
          if (entryLeaf === leaf) continue; // already failed direct check; skip self
          const entryPath = path.join(rulesDir, `${entryLeaf}.md`);
          if (!existsSync(entryPath)) continue;
          const entryContent = readFileSync(entryPath, 'utf8');
          const declaredLeaves = extractDeclaredLoadChainRefs(entryContent)
            .map(resolveDeclaredRootLeaf)
            .filter(Boolean);
          if (declaredLeaves.includes(leaf)) return false; // 1-hop covered → not missing
        }
        return true; // truly unreachable
      });

      if (stillMissing.length > 0) {
        process.stderr.write(
          `Pre-PR archive gate (k)：以下新增 rule .md 在 AGENTS.md 中無索引 entry：\n` +
          stillMissing.map((m) => `  - .devpro/agent-rules/${m}.md`).join('\n') + '\n\n' +
          `AGENTS.md 未索引的 rule leaf 永遠不會被 on-demand load，規範等同失效。\n` +
          `（且未被任何已索引 entry leaf 以 Load-chain 引用）\n` +
          `修法 1：若此 leaf 是獨立 hot-path rule，在 AGENTS.md 的觸發索引段新增 direct entry。\n` +
          `修法 2：若此 leaf 是既有直接 entry leaf 的 conditional sibling，在該直接 entry leaf 補上 line-anchored explicit Load-chain declaration。\n`
        );
        process.exit(1);
      }
    }
  }
}

// (m) Requirement Ledger lifecycle check.
// Scope-bound to relevant archives: old archives predate this rule and should
// not block unrelated PRs. The gate validates only the parseable contract
// (columns, accepted dispositions, next-step trace, and task coverage). It
// deliberately does not claim semantic completeness versus meeting-notes/user
// wording; that is reviewer / cross-model / user-review territory.
{
  const REQUIRED_LEDGER_COLUMNS = [
    'ID',
    'Root Requirement',
    'Parent Requirement',
    'Current Requirement',
    'Disposition',
    'Owner / Next Step',
  ];
  const ACCEPTED_DISPOSITIONS = new Set([
    'implemented',
    'partial',
    'deferred',
    'rejected',
    'moved-to-issue',
  ]);
  const NON_IMPLEMENTED = new Set(['partial', 'deferred', 'rejected', 'moved-to-issue']);
  const PLACEHOLDER_RE = /^(?:-|n\/a|na|none|tbd|todo|待補|未定|<[^>]+>)$/i;

  // Single-source canonical ledger example appended to every gate (m) checkpoint
  // error message so authors see the full compliant shape in one go (anti-squeeze
  // pattern: each early checkpoint used to reveal only the next missing element).
  //
  // Lineage rules: Root = original requirement that spawned the line; Parent = the
  // most recent carry-over row from a previous change (set to root value for a
  // first-time requirement); Current = THIS change's scope only.
  // Coverage rule: every implemented/partial row needs [Req: R<N>] in Tasks.
  // Forbidden: range tags such as [Req: R1-R7] — use exact IDs per row.
  const CANONICAL_LEDGER_EXAMPLE =
    '\n合規 Requirement Ledger 範例（6 欄 markdown table + task coverage）：\n\n' +
    '| ID | Root Requirement | Parent Requirement | Current Requirement | Disposition | Owner / Next Step |\n' +
    '|---|---|---|---|---|---|\n' +
    '| R1 | 原始需求來源（issue / user story / 前 PR 描述） | 前次 carry-over row（首次 = 同 Root）| 本 change 實際 scope | implemented | this PR |\n\n' +
    'Tasks 中對應的 coverage 標記：\n' +
    '- [ ] [Req: R1] 實作 xxx（每個 implemented/partial row 必須有此標記）\n\n' +
    'lineage 規則：Root = 原始需求；Parent = 前次 carry-over（首次 = 同 Root）；Current = 本 change scope。\n' +
    '禁用 range 標記（如 [Req: R1-R7]）；每 row 需個別 [Req: R<N>]。\n';

  // Row recognition (cell normalisation, row splitting, id shape) is shared
  // with lint-requirement-count-ratchet.mjs via lib/requirement-ledger-rows.mjs
  // so the two gates can never disagree about which cells hold requirement ids.
  // The section locators are NOT shared — see that lib's header for the exact
  // boundary of the guarantee.
  //
  // The ledger read used for TASK COVERAGE (section locator, table parser,
  // `[Req: ...]` ref extraction) and the bidirectional comparison itself moved
  // out of this gate to lib/requirement-task-coverage.mjs, so that
  // lint-proposal-tasks-checked.mjs can ask the same question BEFORE archive
  // against the active change folder and get the same answer
  // (fix-zero-value-review-rounds R7). What stays here is this gate's own
  // question — is the ledger well-formed? — the Root / Parent / Current /
  // Disposition / Owner-Next-Step field checks below, and every message string.

  for (const archiveName of relevantArchives) {
    const archivePath = path.join('openspec/changes/archive', archiveName);
    let ledger;
    try { ledger = readRequirementLedger(path.join(archiveDir, archiveName)); }
    catch (err) {
      process.stderr.write(`Pre-PR archive gate (m): failed to read Requirement Ledger in ${archivePath}: ${err.message}\n`);
      process.exit(1);
    }
    if (ledger.status === 'no-proposal-carrier') continue;
    if (!['ok', 'no-requirement-ledger', 'requirement-ledger-table-missing'].includes(ledger.status)) {
      const detail = ledger.duplicate ? `duplicate Requirement Ledger ID: ${ledger.duplicate}`
        : ledger.malformed ? `malformed formal Ledger row: ${ledger.malformed}`
          : 'keep one live formal Ledger with complete, unique rows';
      process.stderr.write(`Pre-PR archive gate (m): ${archivePath}: ${ledger.status}; ${detail}\n`);
      process.exit(1);
    }
    const proposalBody = ledger.body;
    const ledgerSection = ledger.section ?? null;

    if (ledgerSection === null) {
      process.stderr.write(
        `Pre-PR archive gate (m)：archive folder ${archivePath} 之 proposal 缺 ## Requirement Ledger。\n` +
        `Requirement Ledger 是原始需求 → proposal scope → tasks/QA/PR completion 的 handoff contract。\n` +
        `修正：在 proposal.md/proposal-mini.md 補上 ledger，欄位包含 ${REQUIRED_LEDGER_COLUMNS.join(' / ')}。\n` +
        CANONICAL_LEDGER_EXAMPLE
      );
      process.exit(1);
    }

    const table = ledger.table;
    if (!table || table.rows.length === 0) {
      process.stderr.write(
        `Pre-PR archive gate (m)：archive folder ${archivePath} 之 Requirement Ledger 缺 parseable markdown table 或資料列。\n` +
        `修正：使用 proposal-template.md 的 Requirement Ledger 表格格式，欄位包含 ${REQUIRED_LEDGER_COLUMNS.join(' / ')}（markdown table，非 bullet list）。\n` +
        CANONICAL_LEDGER_EXAMPLE
      );
      process.exit(1);
    }

    const headerIndex = new Map(table.header.map((name, idx) => [name, idx]));
    const missingColumns = REQUIRED_LEDGER_COLUMNS.filter((column) => !headerIndex.has(column));
    if (missingColumns.length > 0) {
      process.stderr.write(
        `Pre-PR archive gate (m)：archive folder ${archivePath} 之 Requirement Ledger 缺少 lineage 欄位：\n` +
        missingColumns.map((c) => `  - ${c}`).join('\n') + '\n\n' +
        `Root Requirement 保留最初需求；Parent Requirement 指上一個 carry-over row；Current Requirement 才是本 change 的 scope。\n` +
        CANONICAL_LEDGER_EXAMPLE
      );
      process.exit(1);
    }

    const rowErrors = [];
    // Coverage identity (row number, ID, Disposition) comes from the shared
    // module, so this gate and the pre-archive lint key coverage off the same
    // cells and number the same rows. The four lineage columns read below are
    // gate (m)'s own question and stay here.
    const ledgerRows = collectCoverageLedgerRows(table);
    for (const [idx, row] of table.rows.entries()) {
      const { rowNumber, id, disposition } = ledgerRows[idx];
      const get = (column) => normalizeLedgerCell(row[headerIndex.get(column)] || '');
      const root = get('Root Requirement');
      const parent = get('Parent Requirement');
      const current = get('Current Requirement');
      const ownerNext = get('Owner / Next Step');

      const idIsValid = hasRequirementId(id);
      if (!idIsValid) {
        rowErrors.push(`row ${rowNumber}: ID must look like R1 / R2 / R1a`);
      }
      if (!root || PLACEHOLDER_RE.test(root)) {
        rowErrors.push(`row ${rowNumber} (${id || 'unknown'}): Root Requirement is empty/placeholder`);
      }
      if (!parent || PLACEHOLDER_RE.test(parent)) {
        rowErrors.push(`row ${rowNumber} (${id || 'unknown'}): Parent Requirement is empty/placeholder`);
      }
      if (!current || PLACEHOLDER_RE.test(current)) {
        rowErrors.push(`row ${rowNumber} (${id || 'unknown'}): Current Requirement is empty/placeholder`);
      }
      if (!ACCEPTED_DISPOSITIONS.has(disposition)) {
        rowErrors.push(
          `row ${rowNumber} (${id || 'unknown'}): Disposition must be one of ${Array.from(ACCEPTED_DISPOSITIONS).join(', ')}`
        );
      }
      if (!ownerNext || PLACEHOLDER_RE.test(ownerNext)) {
        rowErrors.push(`row ${rowNumber} (${id || 'unknown'}): Owner / Next Step is empty/placeholder`);
      }
      if (NON_IMPLEMENTED.has(disposition) && (!ownerNext || PLACEHOLDER_RE.test(ownerNext))) {
        rowErrors.push(`row ${rowNumber} (${id || 'unknown'}): non-implemented disposition requires owner/issue/next action`);
      }
    }

    const resolvedLedger = resolveExecutableTaskLedgerCarrier(path.join(archiveDir, archiveName));
    const taskCoverageBody = resolvedLedger
      ? readFileSync(resolvedLedger.absolutePath, 'utf8')
      : proposalBody;
    const taskCoverageSource = resolvedLedger
      ? resolvedLedger.filename
      : 'proposal/proposal-mini Tasks';
    const coverage = compareRequirementTaskCoverage({ ledgerRows, taskBody: taskCoverageBody });

    for (const invalidRange of coverage.invalidRanges) {
      rowErrors.push(
        `${taskCoverageSource}: [Req: ${invalidRange}] is a range; use exact Requirement Ledger IDs such as [Req: R1] [Req: R2], not [Req: R1-R7]`
      );
    }

    for (const taskRef of coverage.unknownRefs) {
      rowErrors.push(
        `${taskCoverageSource}: [Req: ${taskRef}] has no matching Requirement Ledger row; use exact IDs from the 6-column ledger table`
      );
    }

    for (const row of coverage.uncoveredRows) {
      rowErrors.push(
        `row ${row.rowNumber} (${row.id}): ${row.disposition} disposition requires [Req: ${row.id}] task coverage in ${taskCoverageSource}`
      );
    }

    if (rowErrors.length > 0) {
      process.stderr.write(
        `Pre-PR archive gate (m)：archive folder ${archivePath} 之 Requirement Ledger 不完整：\n` +
        rowErrors.map((e) => `  - ${e}`).join('\n') + '\n\n' +
        `Accepted dispositions: ${Array.from(ACCEPTED_DISPOSITIONS).join(', ')}。\n` +
        `來源規範：.devpro/agent-rules/openspec-quality-and-formats.md Requirement Ledger Lifecycle。\n` +
        CANONICAL_LEDGER_EXAMPLE
      );
      process.exit(1);
    }
  }
}

// (o) Task checkbox execution-state backstop (post-archive terminal guard for
// the execution-loop clause: openspec-quality-and-formats.md §Tasks.md 品質要求 執行迴路).
// The pre-archive lint (lint-proposal-tasks-checked.mjs, joined in /devpro:pre-pr
// Step 3.6) reads the ACTIVE change folder before `openspec archive`; this check
// is its post-archive mirror — it reads the ARCHIVED folder and re-runs the same
// verification via the shared `lintProposalTasksChecked` function (DRY: one SSOT
// for the single-ledger + checkbox rule; carrier selection delegated to
// lib/task-ledger-resolution.mjs). Catches the case where the archive was produced without
// the pre-archive lint ever running (e.g. manual archive, recovery re-do), so a
// full proposal/tasks duplicate ledgers, unchecked tasks, empty check-offs, or
// sibling-section top-level `- [ ]` (issue #1893) cannot reach PR.
//
// Placement (CRITICAL): BEFORE the `if (!anySpecsFound)` chore-A pass-through
// below, because a B-mini change (proposal-mini.md, no specs/) — the primary
// checkbox-miss scenario (see PR #1430) — has no spec delta and would otherwise
// exit at that pass-through before ever reaching (o). It shares (m)'s
// no-spec-still-checked contract: a no-spec proposal must still clear (o).
//
// Design constraints (mirror check (n)):
//   - scope-bound to relevantExistingArchives; empty set → loop body never runs
//     (fail-open, additive gate — never blocks unrelated PRs).
//   - reads archive/<archiveName>/ (proposal-mini.md preferred for B-mini; otherwise
//     tasks.md plus proposal.md duplicate-ledger detection, via the shared fn).
//   - graceful pass on chore-A archive (no proposal/tasks), or no `## Tasks`
//     section AND no top-level task checkbox anywhere in the carrier; a
//     carrier with a checkbox under a non-canonical heading now hard-fails
//     instead (see lintProposalTasksChecked's `tasksBody === null` branch).
//   - sibling-unchecked policy lives ONLY in lintProposalTasksChecked (no second
//     scanner here); Deferred-body `- [ ]` remains authorised via that shared path.
for (const archiveName of relevantExistingArchives) {
  const archivedChangeFolder = path.join(archiveDir, archiveName);
  if (!existsSync(archivedChangeFolder)) continue; // fail-open: archive not found
  let result;
  try {
    result = lintProposalTasksChecked({ changeFolder: archivedChangeFolder });
  } catch {
    continue; // fail-open on unexpected error (additive gate, never fail-closed)
  }
  if (result.error) continue; // fail-open on folder-resolution error
  if (!result.pass) {
    const relPath = `openspec/changes/archive/${archiveName}`;
    process.stderr.write(
      `Pre-PR archive gate (o)：archived change ${relPath} 的 task checklist 不合格（執行迴路收尾層）：\n` +
      result.violations.map((v) => `  - ${v.kind}: "${v.task}" — ${v.detail}`).join('\n') + `\n\n` +
      `成因：full proposal.md 與 tasks.md 同時承載 executable checkbox ledger，或 canonical ledger 有未逐條回勾／空打勾 task，或 Tasks 外 sibling 段出現 top-level \`- [ ]\`（sibling-unchecked）。\n` +
      `此為 lint-proposal-tasks-checked.mjs（pre-archive）的 archive 後兜底鏡像（含 sibling 政策；(o) 不另寫第二套規則）。\n\n` +
      `修正方式：\n` +
      `  1. duplicate-ledger：把 task 保留／移到 tasks.md，proposal.md Section 3 只留 non-executable pointer／scope 摘要；\n` +
      `  2. unchecked：逐條認領→做→當下回勾，或在 canonical ledger 加 \`## Deferred\` 明示授權；\n` +
      `  3. 空打勾：補該 task 的 \`[Req: R#]\` ledger tag + 一行 \`驗收:\` 證據句；\n` +
      `  4. sibling-unchecked：把 Tasks 外 top-level \`- [ ]\` 移入 Tasks／完成回勾，或放到 \`## Deferred\` body。\n\n` +
      `Reference: openspec-quality-and-formats.md §Tasks.md 品質要求「執行迴路」；lint-proposal-tasks-checked.mjs。\n`
    );
    process.exit(1);
  }
}

// (q) design.md format-when-present check (BRD FR5 / Cooperative watershed —
// amend-openspec-artifact-model). design.md is NEVER required — an archive
// with no design.md always passes this check (no presence gate). But when a
// PR-touched relevant archive DOES contain design.md, its hook-enforced
// required headings must be present.
//
// Required headings mirror `.devpro/agent-rules/design-template.md`'s
// hook-enforced heading list (`## Context`, `## Decisions`) — single SSOT,
// kept here as exactly one constant so this file never carries a second,
// drifting copy of the heading list.
//
// Design constraints (mirror check (o), NOT (c)'s bcEvalArchives
// empty-set-fallback-to-latest pattern):
//   - scope-bound to relevantExistingArchives; empty set → loop body never
//     runs (fail-open, additive gate — never blocks unrelated PRs, and never
//     retroactively validates a pre-existing (Grandfather) design.md this PR
//     did not touch).
//   - placed BEFORE the `if (!anySpecsFound)` chore-A pass-through below (same
//     placement rationale as (o)): a chore-A archive (no specs/) can still
//     carry an optional design.md, so this check must run regardless of
//     anySpecsFound.
//   - reads archive/<archiveName>/design.md directly (no shared-fn indirection
//     needed; format check is a simple per-heading regex test).
const DESIGN_MD_REQUIRED_HEADINGS = ['## Context', '## Decisions'];
for (const archiveName of relevantExistingArchives) {
  const designPath = path.join(archiveDir, archiveName, 'design.md');
  if (!existsSync(designPath)) continue; // no design.md → always pass (no presence gate)
  const body = readFileSync(designPath, 'utf8');
  const missingHeadings = DESIGN_MD_REQUIRED_HEADINGS.filter(
    (heading) => !new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(body)
  );
  if (missingHeadings.length > 0) {
    process.stderr.write(
      `Pre-PR archive gate (q): Archive ${archiveName}/design.md missing required heading(s): ${missingHeadings.join(' / ')}\n` +
      `\n` +
      `design.md is optional (Cooperative watershed — never required to exist), but when present its\n` +
      `hook-enforced headings must be complete.\n` +
      `Fix: add the missing heading(s) to openspec/changes/archive/${archiveName}/design.md.\n` +
      `Reference: .devpro/agent-rules/design-template.md\n`
    );
    process.exit(1);
  }
}

// (i) Capability spec scenario removal guard (issue #722).
// Compares `#### Scenario:` title sets at baseline ref vs HEAD for each
// openspec/specs/<cap>/spec.md the branch modifies. Blocks on silent removal
// unless an explicit `## Removed Scenarios` declaration is present in any
// relevant archive's proposal-mini.md / proposal.md / tasks.md / decisions.md,
// or, for a PR with no archive below full rigor, in the PR body named by --pr.
//
// Exemption (issue #784): rules/<source>-v<X.Y.Z> branches per rules-flow.md §
// Dedicated Rules Branch use anchor-sha as base (not main), so diffing HEAD
// against origin/main produces false silent-removal verdicts whenever main
// has scenarios added after the anchor. Rules sync commits physically cannot
// modify openspec/specs/<cap>/spec.md (not in SYNC_DIRS per sync-agent-rules.mjs),
// so skipping (i) on rules branches is safe.
{
  // Rules-lane early-exit: anchor-base by design (rules-flow.md step 4);
  // scenario diff against origin/main is meaningless (HEAD intentionally lags
  // when main has spec churn after the anchor). Rules commits physically
  // cannot modify openspec/specs/<cap>/spec.md (not in SYNC_DIRS per
  // sync-agent-rules.mjs), so skipping (i) on rules branches is safe.
  // Uses RULES_BRANCH_RE from lib/branch-naming.mjs as SSOT (same regex as
  // cross-model gate exemption + validateRulesBranch).
  {
    let branchProbe = '';
    try {
      const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' });
      if (r.status === 0) branchProbe = (r.stdout || '').trim();
    } catch {}
    if (branchProbe && RULES_BRANCH_RE.test(branchProbe)) {
      if (!anySpecsFound) passArchiveGate('chore-A or no spec delta');
      passArchiveGate('(i) scenario-removal check skipped: rules branch', evidenceArchive);
    }
  }

  const baselineRef = process.env.DEVPRO_SCENARIO_DIFF_BASELINE_REF || 'origin/main';

  // Defence-in-depth: baselineRef enters git CLI as `<ref>:<path>` and
  // `<ref>..HEAD`. spawnSync arg-array already avoids shell parsing, but a
  // pathological ref (control chars, leading `-` parsed as flag) could still
  // confuse `git`. Whitelist the legal ref-name shape upfront so the gate
  // exits with a clear error instead of relying on git's own rejection.
  if (!/^[\w./@\-]+$/.test(baselineRef) || baselineRef.startsWith('-')) {
    process.stderr.write(
      `Pre-PR archive gate (i)：DEVPRO_SCENARIO_DIFF_BASELINE_REF shape invalid: ${JSON.stringify(baselineRef)}\n` +
      `Allowed: [A-Za-z0-9_./@-]+; must not start with '-'.\n`
    );
    process.exit(1);
  }

  // If cwd is not inside a git repo at all, there is no baseline to compare
  // against — let other gates do their work. This keeps non-git test fixtures
  // and ad-hoc directories from spuriously failing-closed. Production CI/
  // local PR contexts always run inside a git repo, so this does not weaken
  // the bypass-prevention codex flagged.
  const inGitRepo = spawnSync(
    'git',
    ['-C', cwd, 'rev-parse', '--is-inside-work-tree'],
    { stdio: ['ignore', 'pipe', 'ignore'] }
  );
  if (inGitRepo.error || inGitRepo.status !== 0) {
    if (!anySpecsFound) passArchiveGate('chore-A or no spec delta');
    passArchiveGate('(i) scenario-removal check skipped: not a git repo', evidenceArchive);
  }

  // (r) Archive/promote commit-ordering guard.
  //
  // Everything below reads COMMITTED state: `changedSpecs` comes from a
  // two-dot `<baseline>..HEAD` diff, and cadence (f) resolves the archive
  // folder's introduction commit. Run this gate before the archive/promote is
  // committed and both answer on a state that does not contain the promote —
  // changedSpecs is empty so the scenario-removal comparison below is silently
  // skipped, and (f) reports `indeterminate`. Neither surfaces as a failure,
  // so the run goes green while covering the wrong content. One ordering
  // error, two victims.
  //
  // Placement (CRITICAL): AFTER the rules-branch and not-a-git-repo
  // pass-throughs above, so (r) inherits both exemptions rather than
  // duplicating their probes — rules branches are anchor-based and physically
  // cannot modify openspec/specs/, and non-git fixtures have no committed
  // state to compare. BEFORE the `if (!anySpecsFound)` chore-A pass-through
  // below (same rationale as (o)/(q)): a chore-A archive carries no specs/ but
  // its folder must still reach HEAD for (f) to resolve an introduction
  // commit. Deliberately NOT placed among the earlier blocking checks: (r)
  // exists to stop a false GREEN, so any check that already blocks keeps its
  // own more specific message.
  //
  // Scope: the git-derived basis path only. `DEVPRO_CHANGED_CAPABILITY_SPECS`
  // means the caller supplied the comparison basis explicitly and owns its
  // freshness; production never sets that seam, so the production path is
  // always covered.
  if (
    relevantExistingArchives.length > 0 &&
    process.env.DEVPRO_CHANGED_CAPABILITY_SPECS === undefined
  ) {
    const orderingProbe = (...args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
    const headCommit = orderingProbe('rev-parse', '--verify', 'HEAD');
    // A repo with no commits yet has no HEAD to compare against; skip rather
    // than block (mirrors the not-a-git-repo degradation above).
    if (!headCommit.error && headCommit.status === 0) {
      const uncommittedArchives = relevantExistingArchives.filter((name) => {
        const probe = orderingProbe(
          'ls-tree', '--name-only', 'HEAD', '--', `openspec/changes/archive/${name}`
        );
        return probe.error || probe.status !== 0 || !probe.stdout.trim();
      });
      const promoteStatus = orderingProbe('status', '--porcelain', '--', 'openspec/specs');
      // Fail closed when the promote state cannot be read at all. Collapsing a
      // failed probe into "no dirty promote" would make an unreadable index
      // indistinguishable from a clean one — reproducing, inside (r), the exact
      // false GREEN (r) exists to stop. The sibling archive probe above already
      // treats `probe.error || probe.status !== 0` as "not in HEAD" and blocks;
      // both halves of this check MUST share one disposition.
      if (promoteStatus.error || promoteStatus.status !== 0) {
        const cause = promoteStatus.error
          ? promoteStatus.error.message
          : `exit ${promoteStatus.status}` +
            (promoteStatus.stderr && promoteStatus.stderr.trim()
              ? `：${promoteStatus.stderr.trim()}`
              : '');
        process.stderr.write(
          `Pre-PR archive gate (r)：openspec/specs/ 的 promote 狀態無法判定——探測本身失敗。\n` +
          `  - git status --porcelain -- openspec/specs：${cause}\n` +
          `「無法判定」不等於「乾淨」：放行等於讓守門跑在它讀不到的狀態上，正是本 check 要擋的 false GREEN。\n` +
          `修正：先排除 git 狀態不可讀的成因（index 損壞、index.lock 未釋放、權限、磁碟），再重跑本 gate。\n`
        );
        process.exit(1);
      }
      const dirtyPromote = promoteStatus.stdout.trim();

      if (uncommittedArchives.length > 0 || dirtyPromote) {
        const detail = [];
        if (uncommittedArchives.length > 0) {
          detail.push(`  - archive folder 不在 HEAD：${uncommittedArchives.join(', ')}`);
        }
        if (dirtyPromote) {
          const entries = dirtyPromote.split('\n').map((line) => `      ${line.trim()}`).join('\n');
          detail.push(`  - openspec/specs/ 有未 commit 的 promote：\n${entries}`);
        }
        process.stderr.write(
          `Pre-PR archive gate (r)：archive/promote 尚未 commit，守門會跑在不含 promote 的狀態上。\n` +
          `${detail.join('\n')}\n` +
          `同一個 ordering 錯誤有兩個受害者：\n` +
          `  - check (i)：changed-spec 清單取自兩點 committed diff（<baseline>..HEAD），未 commit 的 promote 不在 HEAD，清單為空而靜默跳過 scenario 移除比對。\n` +
          `  - cadence (f)：找不到 archive folder 的 introduction commit，回報 indeterminate。\n` +
          `修正：先 commit archive/promote，再重跑本 gate。不得以「跑過了」宣告通過——通過只涵蓋它實際讀到的那份內容。\n`
        );
        process.exit(1);
      }
    }
  }

  // Fail-closed: confirm baselineRef resolves to a commit BEFORE running any
  // diff/show. The earlier shape of this gate skipped silently when
  // `origin/main` was missing (CI shallow clone, fresh local checkout),
  // letting silent scenario removals through. PR #724 review evidence:
  // codex reproduced exit 0 on a fixture with `DEVPRO_SCENARIO_DIFF_BASELINE_REF=origin/missing`
  // even though scenarios were silently removed.
  const refResolve = spawnSync(
    'git',
    ['-C', cwd, 'rev-parse', `${baselineRef}^{commit}`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
  );
  if (refResolve.error || refResolve.status !== 0) {
    process.stderr.write(
      `Pre-PR archive gate (i)：baseline ref ${JSON.stringify(baselineRef)} does not resolve to a commit.\n` +
      `Fix one of:\n` +
      `  - \`git fetch origin\` (if baseline is a remote ref like the default \`origin/main\`)\n` +
      `  - set \`DEVPRO_SCENARIO_DIFF_BASELINE_REF=<resolvable-ref>\` (e.g. local \`main\`)\n` +
      `Fail-closed (not fail-open): unresolvable baseline would bypass scenario removal detection.\n`
    );
    process.exit(1);
  }
  const baselineSha = refResolve.stdout.trim();
  const mergeBaseResolve = spawnSync(
    'git',
    ['-C', cwd, 'merge-base', baselineRef, 'HEAD'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
  );
  if (mergeBaseResolve.error || mergeBaseResolve.status !== 0 || !mergeBaseResolve.stdout.trim()) {
    process.stderr.write(
      `Pre-PR archive gate (i)：git merge-base ${JSON.stringify(baselineRef)} HEAD failed.\n` +
      `Fail-closed: cannot distinguish true scenario removals from scenarios added on the base branch after this branch forked.\n`
    );
    process.exit(1);
  }
  const mergeBaseSha = mergeBaseResolve.stdout.trim();

  // Spec path filter applied to BOTH branches (env override + git diff) so the
  // env override cannot smuggle paths outside openspec/specs/<cap>/spec.md
  // into downstream git commands (defence-in-depth; arg-array exec already
  // prevents shell injection, but the regex bounds path-shape semantics).
  const SPEC_PATH_RE = /^openspec\/specs\/[^\/]+\/spec\.md$/;

  let changedSpecs = [];
  if (process.env.DEVPRO_CHANGED_CAPABILITY_SPECS !== undefined) {
    changedSpecs = process.env.DEVPRO_CHANGED_CAPABILITY_SPECS
      .split(',').map((s) => s.trim()).filter(Boolean)
      .filter((p) => SPEC_PATH_RE.test(p));
  } else {
    const diffResult = spawnSync(
      'git',
      ['-C', cwd, 'diff', '--name-only', `${baselineRef}..HEAD`, '--', 'openspec/specs/'],
      { encoding: 'utf8' }
    );
    // Fail-closed: ref has been confirmed to resolve above, so a diff failure
    // here is a genuine git invocation problem, not a missing-baseline excuse.
    if (diffResult.error || diffResult.status !== 0) {
      process.stderr.write(
        `Pre-PR archive gate (i)：git diff against baseline ${JSON.stringify(baselineRef)} failed.\n` +
        (diffResult.stderr ? `stderr: ${diffResult.stderr}\n` : '') +
        `Fail-closed to avoid bypassing scenario removal detection.\n`
      );
      process.exit(1);
    }
    for (const line of diffResult.stdout.split('\n')) {
      if (SPEC_PATH_RE.test(line)) changedSpecs.push(line);
    }
  }

  if (changedSpecs.length > 0) {
    // Reject baseline === HEAD when there are specs to diff: `git diff
    // HEAD..HEAD` is empty, which would silently disable the check.
    // PR #724 round-2 codex finding: `DEVPRO_SCENARIO_DIFF_BASELINE_REF=HEAD`
    // passes shape + rev-parse and (with env override supplying specs to
    // check) would read baseline = current = no diff = no violation.
    // Only enforce when we actually need to read baseline content; an empty
    // changedSpecs list is legitimately a no-op regardless of baseline ref.
    const headResolve = spawnSync(
      'git',
      ['-C', cwd, 'rev-parse', 'HEAD'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    if (!headResolve.error && headResolve.status === 0 && headResolve.stdout.trim() === baselineSha) {
      process.stderr.write(
        `Pre-PR archive gate (i)：baseline ref ${JSON.stringify(baselineRef)} resolves to the current HEAD commit (${baselineSha.slice(0, 7)}).\n` +
        `A baseline equal to HEAD makes the scenario diff a no-op and would silently skip the check.\n` +
        `Pick a ref that diverges from HEAD (e.g. \`main\` from a feature branch, or the anchor SHA).\n`
      );
      process.exit(1);
    }

    // Collect Removed Scenarios declarations from relevant archives.
    // Authors may declare in any of: proposal-mini.md, proposal.md, tasks.md,
    // decisions.md (covers both B-mini and chore-B archive layouts).
    // Parsing logic is SSOT'd in lib/removed-scenarios.mjs (PR #984 Suggestion 1).
    const removedDeclared = new Set();
    for (const archiveName of relevantArchives) {
      for (const title of collectRemovedScenarios(path.join(archiveDir, archiveName))) {
        removedDeclared.add(title);
      }
    }

    const extractScenarioTitles = (content) => {
      const titles = new Set();
      for (const line of content.split('\n')) {
        const m = line.match(/^#### Scenario:\s*(.+?)\s*$/);
        if (m) titles.add(m[1]);
      }
      return titles;
    };

    const violations = [];
    for (const specRelPath of changedSpecs) {
      // Distinguish "path doesn't exist in baseline" (legitimate: brand-new
      // spec on this branch) from a git command failure. `git ls-tree` cleanly
      // separates the two: empty stdout = path absent in tree; non-zero exit
      // = command failure (corrupt object, partial fetch, I/O race, etc).
      // Previously `git cat-file -e` was used but conflated both into the
      // same non-zero status, leaving room for silent skip on git errors
      // (PR #724 round-2 codex finding).
      const lsTree = spawnSync(
        'git',
        ['-C', cwd, 'ls-tree', '--name-only', baselineRef, '--', specRelPath],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      );
      if (lsTree.error || lsTree.status !== 0) {
        // git ls-tree should not fail once ref-resolve succeeded above; any
        // failure here is anomalous (corrupt object, racing checkout, etc).
        // Fail-closed.
        process.stderr.write(
          `Pre-PR archive gate (i)：git ls-tree ${baselineRef} -- ${specRelPath} failed unexpectedly.\n` +
          `Fail-closed.\n`
        );
        process.exit(1);
      }
      if (lsTree.stdout.trim().length === 0) {
        // Brand-new spec on this branch — path absent in baseline tree.
        continue;
      }
      // Use spawnSync arg-array (no shell) — avoids command injection via
      // either baselineRef or specRelPath even though both are shape-validated.
      const showResult = spawnSync(
        'git',
        ['-C', cwd, 'show', `${baselineRef}:${specRelPath}`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      );
      if (showResult.error || showResult.status !== 0) {
        // Existence already confirmed by ls-tree above; reaching here means
        // a genuine git anomaly. Fail-closed to avoid silently skipping the
        // scenario diff and reintroducing the bypass codex caught in PR #724.
        process.stderr.write(
          `Pre-PR archive gate (i)：git show ${JSON.stringify(`${baselineRef}:${specRelPath}`)} failed unexpectedly (ls-tree said the path exists).\n` +
          (showResult.stderr ? `stderr: ${showResult.stderr}\n` : '') +
          `Fail-closed.\n`
        );
        process.exit(1);
      }
      const mergeBasePath = spawnSync(
        'git',
        ['-C', cwd, 'ls-tree', '--name-only', mergeBaseSha, '--', specRelPath],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      );
      if (mergeBasePath.error || mergeBasePath.status !== 0) {
        process.stderr.write(
          `Pre-PR archive gate (i)：git ls-tree ${mergeBaseSha} -- ${specRelPath} failed unexpectedly.\n` +
          `Fail-closed.\n`
        );
        process.exit(1);
      }
      if (mergeBasePath.stdout.trim().length === 0) {
        // The spec was added on the base branch after this branch forked.
        // Its scenarios are not "removed" by the current branch; the PR
        // merge will preserve the base branch copy unless a real conflict is
        // resolved otherwise.
        continue;
      }
      const mergeBaseShow = spawnSync(
        'git',
        ['-C', cwd, 'show', `${mergeBaseSha}:${specRelPath}`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      );
      if (mergeBaseShow.error || mergeBaseShow.status !== 0) {
        process.stderr.write(
          `Pre-PR archive gate (i)：git show ${JSON.stringify(`${mergeBaseSha}:${specRelPath}`)} failed unexpectedly (ls-tree said the path exists).\n` +
          (mergeBaseShow.stderr ? `stderr: ${mergeBaseShow.stderr}\n` : '') +
          `Fail-closed.\n`
        );
        process.exit(1);
      }
      const guardedTitles = extractScenarioTitles(mergeBaseShow.stdout);
      const currentAbsPath = path.join(cwd, specRelPath);
      // Whole-file deletion of a spec that previously had scenarios is itself
      // a removal — treat baseline titles as missing-from-HEAD unless
      // declared. This catches a `git rm openspec/specs/<cap>/spec.md` slip.
      const currentTitles = existsSync(currentAbsPath)
        ? extractScenarioTitles(readFileSync(currentAbsPath, 'utf8'))
        : new Set();
      const missing = [];
      for (const title of guardedTitles) {
        if (!currentTitles.has(title) && !removedDeclared.has(title)) {
          missing.push(title);
        }
      }
      if (missing.length > 0) violations.push({ specPath: specRelPath, missing });
    }

    // No archive in this PR and not full rigor: a lite change, whose declaration lives in the PR body.
    const prBodyDeclaration =
      violations.length > 0 && relevantArchives.length === 0 && resolveRigorLevel({ cwd }) !== 'full'
        ? readPrBodyRemovedScenarios(cwd, prNumber)
        : null;
    const undeclared = violations
      .map((v) => ({ ...v, missing: v.missing.filter((title) => !prBodyDeclaration?.titles.has(title)) }))
      .filter((v) => v.missing.length > 0);

    if (undeclared.length > 0) {
      process.stderr.write(
        `Pre-PR archive gate (i)：canonical capability spec 出現靜默 scenario 移除（issue #722 防再犯）：\n` +
        undeclared.map((v) =>
          `  - ${v.specPath}：\n` +
          v.missing.map((t) => `      • "${t}"`).join('\n')
        ).join('\n') + `\n\n` +
        `成因：openspec archive 套用 ## MODIFIED Requirements delta 時，若 author 只寫新 scenario，CLI 會以替換而非合併方式套用，靜默移除既有 scenarios。openspec validate 不會偵測。\n\n` +
        `修正方式（擇一）：\n` +
        `  (1) 若 scenario 應保留：在 active spec deltas 之 MODIFIED Requirement block 補回所有既有 scenarios（含未變動者），依 Pre-merge Archive Re-do 還原 archive、re-archive。\n` +
        `  (2) 若 scenario 應移除：在本 PR 的 archive 之 proposal-mini.md / proposal.md / tasks.md / decisions.md 任一檔加 \`## Removed Scenarios\` 段，逐行列出 \`- "<Title>"\` 明示授權，再 re-run /devpro:pre-pr。\n` +
        (prBodyDeclaration ? `      ${prBodyDeclaration.note}\n` : '') +
        `\n` +
        `Reference: issue #722；.devpro/agent-rules/openspec-archive-principles.md §Archive 原則 check (i)。\n`
      );
      process.exit(1);
    }
  }
}

if (!anySpecsFound) {
  // No capability spec delta exists, but archive-scoped lifecycle checks and
  // independent check (i) still had to run before the no-spec pass-through.
  passArchiveGate('chore-A or no spec delta');
}

passArchiveGate('archived & promoted', evidenceArchive);
