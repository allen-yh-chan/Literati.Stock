#!/usr/bin/env node
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { posix, win32 } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lintModifiedScenarioPreservation, bareScenarioTitle, formatLocationError, SCENARIO_FIX_HINT } from './lint-modified-scenario-preservation.mjs';
import { lintRiskClassesRecord } from './lint-risk-classes-record.mjs';
import { lintRequirementCountRatchet } from './lint-requirement-count-ratchet.mjs';
import {
  lintDeltaNewScenarioAssertionCoverage,
  printDeltaNewScenarioAssertionCoverageViolations,
  printDeltaScenarioClauseWarnings,
} from './lint-delta-new-scenario-assertion-coverage.mjs';
import { findOpenspecRepoRoot } from './lib/find-root.mjs';
import { collectRemovedScenarios } from './lib/removed-scenarios.mjs';

const REVIEW_REMEDIATION_CLI_PATH = fileURLToPath(new URL('./review-remediation-evidence.mjs', import.meta.url));

const ACTIVE_PATH_API = process.platform === 'win32' ? win32 : posix;

function usage() {
  return [
    'Usage: node .devpro/scripts/validate-openspec-change.mjs <change-name|archive/name|openspec/changes/name|absolute-change-path> [--risk-shape-probe] [openspec validate flags]',
    '',
    'Validates one OpenSpec change (full proposal.md is the primary path). Runs',
    'scenario-preservation lint on the resolved real change folder before',
    '`openspec validate` (full and B-mini alike). When `## Removed Scenarios` is',
    'non-empty, or for B-mini proposal-mini.md-only / archived targets, creates a',
    'temp openspec copy (materialized regular files), optionally strips declared',
    'removed scenarios from temp canonical specs, projects/shims as needed, then',
    'validates. The working tree is not modified.',
    '',
    '--risk-shape-probe: after the other checks pass, runs the same round-1',
    'risk-shape derivation classify-bounded uses at pre-PR Step 3, via the existing',
    'production façade (review-remediation-evidence.mjs). `--strict` implies this',
    'probe (authoring / pre-PR gate recipes default to `--strict`); bare validate',
    'without `--strict` and without this flag stays probe-off. Requires proposal.md/',
    'proposal-mini.md (and design.md for full changes, plus every specs/<capability>/',
    'spec.md for full and B-mini alike) to already be committed (working tree bytes',
    'must match HEAD) — an',
    'uncommitted carrier fails with a distinct not-committed message naming it, rather',
    'than a misleading risk_shape_unavailable. Archived targets print a skip notice',
    'and exit 0 for this check (archived changes are historical record, not an',
    'authoring-time target).',
  ].join('\n');
}

function toGitPath(value, pathApi) {
  return pathApi.sep === '\\' ? value.replaceAll('\\', '/') : value;
}

function isWithin(parent, child, pathApi) {
  const rel = pathApi.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !pathApi.isAbsolute(rel));
}

function canonicalPath(value, pathApi) {
  return existsSync(value) ? realpathSync(value) : pathApi.resolve(value);
}

function stripTrailingSeparators(value, pathApi) {
  const rootLength = pathApi.parse(value).root.length;
  let end = value.length;
  while (
    end > rootLength &&
    (value[end - 1] === pathApi.sep || (pathApi.sep === '\\' && value[end - 1] === '/'))
  ) {
    end -= 1;
  }
  return value.slice(0, end);
}

export function normalizeChangeTarget(repoRoot, target, { pathApi = ACTIVE_PATH_API } = {}) {
  const trimmed = stripTrailingSeparators(target, pathApi);
  const changesRoot = pathApi.join(repoRoot, 'openspec', 'changes');
  const normalizedTarget = pathApi.normalize(trimmed);
  const targetParts = normalizedTarget.split(pathApi.sep);
  const changeFolder = pathApi.isAbsolute(normalizedTarget)
    ? pathApi.resolve(normalizedTarget)
    : targetParts[0] === 'archive'
      ? pathApi.join(changesRoot, normalizedTarget)
      : targetParts.length > 1
        ? pathApi.resolve(repoRoot, normalizedTarget)
        : pathApi.join(changesRoot, normalizedTarget);

  const canonicalChangesRoot = canonicalPath(changesRoot, pathApi);
  const canonicalChangeFolder = canonicalPath(changeFolder, pathApi);

  if (!isWithin(canonicalChangesRoot, canonicalChangeFolder, pathApi)) {
    return {
      error: `[validate-openspec-change] target must resolve under ${changesRoot}: ${target}`,
      changeFolder,
    };
  }

  const changeRelPath = toGitPath(pathApi.relative(canonicalChangesRoot, canonicalChangeFolder), pathApi);
  if (!changeRelPath || changeRelPath === 'archive') {
    return {
      error: `[validate-openspec-change] target must identify a change folder under ${changesRoot}: ${target}`,
      changeFolder,
    };
  }

  return {
    changeName: pathApi.basename(changeFolder),
    changeFolder,
    changeRelPath,
    isArchived: changeRelPath.startsWith('archive/'),
  };
}

function hasSpecsDelta(changeFolder) {
  const specsDir = ACTIVE_PATH_API.join(changeFolder, 'specs');
  if (!existsSync(specsDir) || !statSync(specsDir).isDirectory()) return false;

  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const entryPath = ACTIVE_PATH_API.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (walk(entryPath)) return true;
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        return true;
      }
    }
    return false;
  }

  return walk(specsDir);
}

/** @type {RegExp} */
export const WIN32_SAFE_CHANGE_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** @type {RegExp} */
export const WIN32_SAFE_VALIDATE_FLAG_RE = /^--[A-Za-z0-9-]+$/;

/**
 * Fail closed on win32 before shell-backed openspec spawn when dynamic argv tokens
 * could reach cmd.exe metacharacter interpretation.
 *
 * @param {string} changeName
 * @param {readonly string[]} validateFlags
 * @param {{ platform?: string }} [options]
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function assertWin32OpenspecSpawnArgs(changeName, validateFlags, { platform = process.platform } = {}) {
  if (platform !== 'win32') return { ok: true };
  if (!WIN32_SAFE_CHANGE_SEGMENT_RE.test(changeName)) {
    return {
      ok: false,
      reason: `change name '${changeName}' contains characters unsafe for win32 shell-backed openspec spawn`,
    };
  }
  for (const flag of validateFlags) {
    if (!WIN32_SAFE_VALIDATE_FLAG_RE.test(flag)) {
      return {
        ok: false,
        reason: `validate flag '${flag}' is not an allowlisted openspec CLI flag for win32 shell-backed spawn`,
      };
    }
  }
  return { ok: true };
}

/** @param {string} cwd @param {{ platform?: string }} [options] */
export function openspecValidateSpawnOptions(cwd, { platform = process.platform } = {}) {
  return {
    cwd,
    encoding: 'utf8',
    ...(platform === 'win32' ? { shell: true } : {}),
  };
}

function printScenarioViolations(result) {
  if (result.error) {
    process.stderr.write(`[validate-openspec-change] ${result.error}\n`);
    return;
  }
  for (const loc of result.locationErrors ?? []) {
    process.stderr.write(formatLocationError('validate-openspec-change', loc));
  }
  for (const v of result.violations) {
    for (const title of v.missing) {
      process.stderr.write(
        `[validate-openspec-change] ${v.cap} :: Requirement "${v.requirement}" :: missing scenario "${bareScenarioTitle(title)}"\n`
      );
    }
    for (const title of v.removedUndeclared ?? []) {
      process.stderr.write(
        `[validate-openspec-change] ${v.cap} :: Requirement "${v.requirement}" :: removed scenario "${title}" not declared\n`
      );
    }
  }
  process.stderr.write(SCENARIO_FIX_HINT);
}

function printRiskClassesViolations(result) {
  if (result.error) {
    process.stderr.write(`[validate-openspec-change] risk_classes: ${result.error}\n`);
    return;
  }
  for (const v of result.violations) {
    const loc =
      v.file && v.line
        ? `${v.file}:${v.line}`
        : v.file
          ? v.file
          : 'change folder';
    process.stderr.write(
      `[validate-openspec-change] risk_classes ${loc}: ${v.reason}${v.detail ? ` — ${v.detail}` : ''}\n`
    );
  }
  process.stderr.write(
    '\nFix: add leading YAML front matter:\n' +
      '---\n' +
      'risk_classes: [auth]\n' +
      '# or risk_classes: none\n' +
      '# rationale: <substantive text>   # required when none\n' +
      '---\n' +
      'in proposal.md / proposal-mini.md / meeting-notes.md / brd.md.\n' +
      'Prose / fence / <pre> body examples do not satisfy the gate.\n' +
      'Chore A (no proposal.md and no proposal-mini.md) is exempt. Carrier: lint-risk-classes-record.mjs.\n'
  );
}

function printRequirementCountRatchetViolations(result) {
  if (result.error) {
    process.stderr.write(`[validate-openspec-change] requirement-count-ratchet: ${result.error}\n`);
    return;
  }
  for (const v of result.violations) {
    const loc = v.file ? v.file : 'change folder';
    process.stderr.write(
      `[validate-openspec-change] requirement-count-ratchet ${loc}: ${v.reason}` +
      `${v.detail ? ` \u2014 ${v.detail}` : ''}\n`
    );
  }
  process.stderr.write(
    '\nFix: the ratchet clears only through a structured row in decisions.md:\n\n' +
      '## Requirement Baseline Ledger\n\n' +
      '| decision_id | trigger | baseline_from | baseline_to |\n' +
      '|---|---|---|---|\n' +
      '| D1 | initial | 0 | 5 |\n' +
      '| D7 | scope-change | 5 | 9 |\n\n' +
      'Every decision_id needs a real numbered decision heading in the same file, ids must be\n' +
      'unique, the first row starts from 0, and each baseline_from equals the previous\n' +
      'baseline_to. Prose mentioning the trigger name does not clear the ratchet.\n' +
      'Carrier: lint-requirement-count-ratchet.mjs.\n'
  );
}

/**
 * `classifyBoundedRereview`'s risk-shape derivation (`deriveRiskShapeSnapshot`
 * in review-remediation-evidence-core.mjs) pins every one of these paths to
 * the committed Git object at HEAD, not just the proposal: for a full change
 * it also pins `design.md` (unconditionally required) and every
 * `specs/<capability>/spec.md` under the change folder; for a B-mini change
 * it pins the same `specs/<capability>/spec.md` set. An uncommitted edit to
 * any of them — not only proposal.md/proposal-mini.md — produces the same
 * pinning failure. This enumerates that exact carrier set (never the whole
 * change folder, so unrelated edits to meeting-notes.md/tasks.md don't
 * false-block) so the "not committed yet" check covers what the façade
 * actually reads.
 *
 * @param {{ changeFolder: string, proposalPath: string, proposalMiniPath: string, hasProposal: boolean }} args
 * @returns {string[]} absolute paths of carriers classify-bounded would pin
 */
function listRiskShapeCarrierPaths({ changeFolder, proposalPath, proposalMiniPath, hasProposal }) {
  const paths = [hasProposal ? proposalPath : proposalMiniPath];
  if (hasProposal && existsSync(ACTIVE_PATH_API.join(changeFolder, 'design.md'))) {
    paths.push(ACTIVE_PATH_API.join(changeFolder, 'design.md'));
  }
  const specsDir = ACTIVE_PATH_API.join(changeFolder, 'specs');
  if (existsSync(specsDir) && statSync(specsDir).isDirectory()) {
    for (const entry of readdirSync(specsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const specPath = ACTIVE_PATH_API.join(specsDir, entry.name, 'spec.md');
      if (existsSync(specPath)) paths.push(specPath);
    }
  }
  return paths;
}

/**
 * Returns the repo-relative paths (git-style, `/`-separated) among
 * `carrierRelPaths` whose working-tree bytes are not byte-identical to the
 * committed blob at HEAD — the same exact-byte pin `classify-bounded`'s
 * `deriveRiskShapeSnapshot` applies. `git status --porcelain` cannot stand in
 * for this: status is EOL-normalization-aware (e.g. `core.autocrlf`), so a
 * checkout can report clean while the raw worktree bytes still differ from
 * the LF blob at HEAD. Comparing raw bytes directly keeps this probe's
 * not-committed diagnosis accurate on any line-ending configuration.
 *
 * @param {string} repoRoot
 * @param {string[]} carrierRelPaths
 * @returns {string[]} repo-relative paths that are missing, untracked, or byte-divergent from HEAD
 */
function findCarrierPathsByteDivergentFromHead(repoRoot, carrierRelPaths) {
  const divergent = [];
  for (const relPath of carrierRelPaths) {
    const absPath = ACTIVE_PATH_API.resolve(repoRoot, relPath);
    if (!existsSync(absPath)) {
      divergent.push(relPath);
      continue;
    }
    const headBlob = spawnSync('git', ['show', `HEAD:${relPath}`], { cwd: repoRoot });
    if (headBlob.status !== 0 || !Buffer.isBuffer(headBlob.stdout)) {
      divergent.push(relPath);
      continue;
    }
    const workingBytes = readFileSync(absPath);
    if (Buffer.compare(workingBytes, headBlob.stdout) !== 0) {
      divergent.push(relPath);
    }
  }
  return divergent;
}

/**
 * Near-miss detector for design.md `## Decisions` headings. Mirrors
 * `findNearMissDecisionHeadings` in review-remediation-evidence-core.mjs so the
 * wrapper can name `標題格式不對` instead of only bare `risk_shape_unavailable`.
 */
function hasNearMissDecisionHeadings(designText) {
  const headingMatch = designText.match(/^## Decisions[ \t]*\r?\n/m);
  if (!headingMatch) return false;
  const start = headingMatch.index + headingMatch[0].length;
  const rest = designText.slice(start);
  const nextHeading = rest.search(/^## /m);
  const block = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
  for (const line of block.split(/\r?\n/u)) {
    if (!/^###\s/u.test(line)) continue;
    if (/^### D([1-9][0-9]*) — (.+)$/u.test(line)) continue;
    if (/^###\s*D[1-9][0-9]*/u.test(line)) return true;
  }
  return false;
}

/**
 * Authoring-time risk-shape probe: reuses the existing `classify-bounded`
 * production façade (`review-remediation-evidence.mjs`) to run the same
 * round-1 risk-shape derivation `classify-bounded` performs at pre-PR Step 3,
 * but right after the proposal (and its pinned sibling carriers) are
 * committed — instead of after all implementation work is done.
 *
 * This probe checks commit state of every pinned carrier first and reports a
 * distinct message for that case, never invoking the façade against
 * uncommitted bytes.
 *
 * @param {{ repoRoot: string, changeName: string, carrierRelPaths: string[], designMdMissing: boolean }} args
 * @returns {boolean} true when the probe passes (or is inapplicable)
 */
function runRiskShapeProbe({ repoRoot, changeName, carrierRelPaths, designMdMissing }) {
  if (designMdMissing) {
    process.stderr.write(
      '[validate-openspec-change] risk-shape-probe: design.md is missing. classify-bounded requires design.md for ' +
      'every full change (proposal.md present) — see .devpro/agent-rules/design-template.md; create it, then ' +
      'rerun with --risk-shape-probe.\n'
    );
    return false;
  }
  const dirtyPaths = findCarrierPathsByteDivergentFromHead(repoRoot, carrierRelPaths);
  if (dirtyPaths.length > 0) {
    process.stderr.write(
      `[validate-openspec-change] risk-shape-probe: ${dirtyPaths.join(', ')} not yet committed ` +
      '(missing, untracked, or working-tree bytes differ from the committed HEAD blob — including a line-ending ' +
      'normalization mismatch on a core.autocrlf checkout). classify-bounded pins the proposal, design.md (full ' +
      'changes), and every specs/<capability>/spec.md to the exact committed Git object bytes at HEAD — commit ' +
      'these first (or renormalize line endings to match HEAD), then rerun with --risk-shape-probe.\n'
    );
    return false;
  }

  let tempDir = null;
  try {
    tempDir = mkdtempSync(ACTIVE_PATH_API.join(tmpdir(), 'devpro-risk-shape-probe-'));
    const requestPath = ACTIVE_PATH_API.join(tempDir, 'request.json');
    writeFileSync(requestPath, JSON.stringify({
      repoRoot,
      changeId: changeName,
      previousReceiptRef: null,
      repairDeltaManifestRef: null,
      dependencyClosureManifestRef: null,
      predecessorMatches: [],
    }));
    const probe = spawnSync(process.execPath, [REVIEW_REMEDIATION_CLI_PATH, 'classify-bounded', '--request', requestPath], {
      encoding: 'utf8',
    });
    if (probe.status !== 0) {
      process.stderr.write(`[validate-openspec-change] risk-shape-probe: ${(probe.stderr || probe.stdout || '').trim()}\n`);
      return false;
    }
    let result;
    try {
      result = JSON.parse(probe.stdout);
    } catch {
      process.stderr.write('[validate-openspec-change] risk-shape-probe: unreadable classify-bounded output\n');
      return false;
    }
    if (result.route === 'risk_shape_unavailable') {
      const designPath = ACTIVE_PATH_API.join(repoRoot, 'openspec', 'changes', changeName, 'design.md');
      if (existsSync(designPath)) {
        const designText = readFileSync(designPath, 'utf8');
        if (hasNearMissDecisionHeadings(designText)) {
          process.stderr.write(
            '[validate-openspec-change] risk-shape-probe: 標題格式不對 — `## Decisions` headings must be '
            + '`### D<n> — <title>` (ASCII em-dash + non-empty title). '
            + 'Bare `### D1` or colon variants are rejected. See .devpro/agent-rules/design-template.md.\n'
          );
          return false;
        }
      }
      // Closed-enum category from classify-bounded (never derived from error text), safe to print.
      const debugReason = typeof result.risk_shape_debug_reason === 'string' && /^[a-z0-9_]{1,64}$/.test(result.risk_shape_debug_reason)
        ? ` risk_shape_debug_reason: ${result.risk_shape_debug_reason}.`
        : '';
      process.stderr.write(
        `[validate-openspec-change] risk-shape-probe: risk-shape derivation failed (route: risk_shape_unavailable).${debugReason}\n` +
        'The proposal is missing (or has malformed) a carrier classify-bounded requires — most commonly, for a full ' +
        'change, `## Risk Classes and Material Negatives` or a required `## Consequence Assessment` row. See ' +
        '.devpro/agent-rules/proposal-template.md `## Required Sections` for the exact required headings.\n'
      );
      return false;
    }
    return true;
  } finally {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Exact bare-title comparison, the same as lint-modified-scenario-preservation.mjs
 * and pre-pr-archive-gate.mjs gate (i): a declaration with a `Scenario: ` prefix
 * does not match.
 * @param {string} scenarioHeading - e.g. "Scenario: Invalid Input"
 * @param {Set<string>} removedDeclared
 */
function isAuthorizedRemovedScenario(scenarioHeading, removedDeclared) {
  return removedDeclared.has(scenarioHeading.replace(/^Scenario:\s*/, '').trim());
}

/**
 * Remove matching `#### Scenario:` blocks from a canonical spec body.
 * @param {string} body
 * @param {Set<string>} removedDeclared
 */
export function stripRemovedScenariosFromCanonicalBody(body, removedDeclared) {
  if (!removedDeclared || removedDeclared.size === 0) return body;
  const scenarioRe = /^#### ([^\r\n]+)\r?\n([\s\S]*?)(?=^#### |^### |^## |$(?![\s\S]))/gm;
  return body.replace(scenarioRe, (full, heading) => {
    const trimmed = heading.trim();
    if (!trimmed.startsWith('Scenario:')) return full;
    return isAuthorizedRemovedScenario(trimmed, removedDeclared) ? '' : full;
  });
}

/**
 * Copy a directory tree into `destDir`, materializing every file as a new regular
 * file (file symlink → read bytes → write regular). Never preserves symlinks for
 * later write-through. Directory symlinks are refused (fail closed) to avoid
 * host-tree traversal / cycle exhaustion outside the source root.
 * @param {string} srcDir
 * @param {string} destDir
 * @param {typeof ACTIVE_PATH_API} [pathApi]
 */
export function copyTreeAsRegularFiles(srcDir, destDir, pathApi = ACTIVE_PATH_API) {
  mkdirSync(destDir, { recursive: true });
  for (const name of readdirSync(srcDir)) {
    const srcPath = pathApi.join(srcDir, name);
    const destPath = pathApi.join(destDir, name);
    const st = lstatSync(srcPath);
    if (st.isSymbolicLink()) {
      let followed;
      try {
        followed = statSync(srcPath);
      } catch {
        throw new Error(`broken symlink while materializing openspec copy: ${srcPath}`);
      }
      if (followed.isDirectory()) {
        throw new Error(
          `directory symlink refused while materializing openspec copy (fail closed): ${srcPath}`,
        );
      }
      if (followed.isFile()) {
        writeFileSync(destPath, readFileSync(srcPath));
      } else {
        throw new Error(`unsupported symlink target while materializing openspec copy: ${srcPath}`);
      }
    } else if (st.isDirectory()) {
      copyTreeAsRegularFiles(srcPath, destPath, pathApi);
    } else if (st.isFile()) {
      writeFileSync(destPath, readFileSync(srcPath));
    } else {
      throw new Error(`unsupported filesystem entry while materializing openspec copy: ${srcPath}`);
    }
  }
}

/**
 * Strip declared-removed scenario blocks from temp canonical openspec/specs/** spec.md files.
 * Fail closed if any write target realpath escapes tempRoot.
 * @param {string} tempRoot
 * @param {Set<string>} removedDeclared
 * @param {typeof ACTIVE_PATH_API} [pathApi]
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function stripRemovedScenariosFromTempCanonicalSpecs(
  tempRoot,
  removedDeclared,
  pathApi = ACTIVE_PATH_API,
) {
  if (!removedDeclared || removedDeclared.size === 0) return { ok: true };

  const specsRoot = pathApi.join(tempRoot, 'openspec', 'specs');
  if (!existsSync(specsRoot) || !statSync(specsRoot).isDirectory()) return { ok: true };

  const realTemp = realpathSync(tempRoot);

  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const entryPath = pathApi.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        return {
          ok: false,
          error: `temp canonical tree retained a symlink (refusing strip write-through): ${entryPath}`,
        };
      }
      if (entry.isDirectory()) {
        const nested = walk(entryPath);
        if (!nested.ok) return nested;
        continue;
      }
      if (!entry.isFile() || entry.name !== 'spec.md') continue;

      let realTarget;
      try {
        realTarget = realpathSync(entryPath);
      } catch (err) {
        return { ok: false, error: `cannot realpath strip target ${entryPath}: ${err.message}` };
      }
      if (!isWithin(realTemp, realTarget, pathApi)) {
        return {
          ok: false,
          error: `strip target realpath escapes temp root (fail closed): ${entryPath} -> ${realTarget}`,
        };
      }

      const body = readFileSync(entryPath, 'utf8');
      const next = stripRemovedScenariosFromCanonicalBody(body, removedDeclared);
      if (next === body) continue;

      // Re-check containment immediately before write (D2a).
      try {
        realTarget = realpathSync(entryPath);
      } catch (err) {
        return { ok: false, error: `cannot realpath strip target before write ${entryPath}: ${err.message}` };
      }
      if (!isWithin(realTemp, realTarget, pathApi)) {
        return {
          ok: false,
          error: `strip target realpath escapes temp root before write (fail closed): ${entryPath} -> ${realTarget}`,
        };
      }
      writeFileSync(entryPath, next, 'utf8');
    }
    return { ok: true };
  }

  return walk(specsRoot);
}

function main() {
  const args = process.argv.slice(2);
  const targetIdx = args.findIndex((arg) => !arg.startsWith('-'));

  if (targetIdx === -1 || args.includes('-h') || args.includes('--help')) {
    process.stderr.write(`${usage()}\n`);
    process.exit(targetIdx === -1 ? 2 : 0);
  }

  const target = args[targetIdx];
  const rawFlags = [...args.slice(0, targetIdx), ...args.slice(targetIdx + 1)];

  if (rawFlags.some((arg) => arg === '--all' || arg === '--changes' || arg === '--specs')) {
    process.stderr.write('[validate-openspec-change] per-change wrapper does not accept --all/--changes/--specs\n');
    process.exit(2);
  }

  const riskShapeProbeRequested =
    rawFlags.includes('--risk-shape-probe') || rawFlags.includes('--strict');
  const strictRequested = rawFlags.includes('--strict');
  const validateFlags = rawFlags.filter((arg) => arg !== '--risk-shape-probe');

  const repoRoot = findOpenspecRepoRoot();
  const normalized = normalizeChangeTarget(repoRoot, target);
  if (normalized.error) {
    process.stderr.write(`${normalized.error}\n`);
    process.exit(1);
  }
  const { changeName, changeFolder, changeRelPath, isArchived } = normalized;

  if (!existsSync(changeFolder) || !statSync(changeFolder).isDirectory()) {
    process.stderr.write(`[validate-openspec-change] change folder not found: ${changeFolder}\n`);
    process.exit(1);
  }

  const proposalPath = ACTIVE_PATH_API.join(changeFolder, 'proposal.md');
  const proposalMiniPath = ACTIVE_PATH_API.join(changeFolder, 'proposal-mini.md');
  const hasProposal = existsSync(proposalPath);
  const hasProposalMini = existsSync(proposalMiniPath);
  const needsMiniShim = !hasProposal && hasProposalMini;
  const removedDeclared = collectRemovedScenarios(changeFolder);
  const needsRemovedStrip = removedDeclared.size > 0;
  const needsTemp = isArchived || needsMiniShim || needsRemovedStrip;

  let validateRoot = repoRoot;
  let tempRoot = null;
  let exitCode = 0;

  try {
    // D1: scenario-preservation on the real change folder before upstream CLI.
    const lint = lintModifiedScenarioPreservation({ changeFolder });
    if (!lint.pass || lint.error) {
      printScenarioViolations(lint);
      exitCode = 1;
    } else {
      if (needsTemp) {
        try {
          tempRoot = mkdtempSync(ACTIVE_PATH_API.join(tmpdir(), 'devpro-openspec-validate-'));
          copyTreeAsRegularFiles(
            ACTIVE_PATH_API.join(repoRoot, 'openspec'),
            ACTIVE_PATH_API.join(tempRoot, 'openspec'),
          );
          let tempChangeFolder = ACTIVE_PATH_API.join(tempRoot, 'openspec', 'changes', changeRelPath);

          if (isArchived) {
            const tempArchiveFolder = tempChangeFolder;
            tempChangeFolder = ACTIVE_PATH_API.join(tempRoot, 'openspec', 'changes', changeName);
            rmSync(tempChangeFolder, { recursive: true, force: true });
            copyTreeAsRegularFiles(tempArchiveFolder, tempChangeFolder);
          }

          if (needsMiniShim) {
            copyFileSync(
              ACTIVE_PATH_API.join(tempChangeFolder, 'proposal-mini.md'),
              ACTIVE_PATH_API.join(tempChangeFolder, 'proposal.md'),
            );
          }

          if (needsRemovedStrip) {
            const strip = stripRemovedScenariosFromTempCanonicalSpecs(tempRoot, removedDeclared);
            if (!strip.ok) {
              process.stderr.write(`[validate-openspec-change] ${strip.error}\n`);
              exitCode = 1;
            }
          }

          if (exitCode === 0) validateRoot = tempRoot;
        } catch (err) {
          process.stderr.write(
            `[validate-openspec-change] failed to prepare temp openspec validate tree: ${err.message}\n`,
          );
          exitCode = 1;
        }
      }

      if (exitCode === 0) {
        const spawnGuard = assertWin32OpenspecSpawnArgs(changeName, validateFlags);
        if (!spawnGuard.ok) {
          process.stderr.write(`[validate-openspec-change] ${spawnGuard.reason}\n`);
          process.exit(1);
        }

        const validate = spawnSync(
          'openspec',
          ['validate', changeName, ...validateFlags],
          openspecValidateSpawnOptions(validateRoot),
        );

        if (validate.stdout) process.stdout.write(validate.stdout);
        if (validate.stderr) process.stderr.write(validate.stderr);
        if (validate.error) {
          process.stderr.write(`[validate-openspec-change] failed to run openspec: ${validate.error.message}\n`);
        }

        exitCode = validate.status ?? 1;

        if (hasProposalMini && exitCode !== 0 && !hasSpecsDelta(changeFolder)) {
          process.stderr.write(
            '[validate-openspec-change] 此 B-mini 沒有 specs/ delta。B-mini 必須攜帶至少一個 capability ' +
            'delta（specs/<capability>/spec.md，含 #### Scenario:）。請補一個 delta，或若本變更真的無 ' +
            'capability semantics，改判為 chore A（doc-only fast-track）——no-capability prose 不走 B-mini。\n'
          );
        }
      }

      // risk_classes presence is a pre-archive / active-change gate. Historical
      // archives are grandfathered (no backfill) — invoke lint CLI directly to
      // dogfood a specific archive that already carries the field.
      if (exitCode === 0 && !isArchived) {
        const riskLint = lintRiskClassesRecord({ changeFolder });
        if (!riskLint.pass || riskLint.error) {
          printRiskClassesViolations(riskLint);
          exitCode = 1;
        }
      }

      // Requirement-count ratchet: same pre-archive / active-change scope as
      // risk_classes. Historical archives are grandfathered — none of them
      // carries a `## Requirement Baseline Ledger`, so running the ratchet
      // against them would fail every archived change that has a ledger.
      if (exitCode === 0 && !isArchived) {
        const ratchet = lintRequirementCountRatchet({ changeFolder });
        if (!ratchet.pass || ratchet.error) {
          printRequirementCountRatchetViolations(ratchet);
          exitCode = 1;
        }
      }

      // New delta scenario assertion coverage: authoring / --strict gate only
      // (bare validate stays non-gate for this check).
      if (exitCode === 0 && !isArchived && strictRequested) {
        const coverage = lintDeltaNewScenarioAssertionCoverage({ changeFolder, repoRoot });
        printDeltaScenarioClauseWarnings(coverage);
        if (!coverage.pass || coverage.error) {
          printDeltaNewScenarioAssertionCoverageViolations(coverage);
          exitCode = 1;
        }
      }

      if (exitCode === 0 && riskShapeProbeRequested && isArchived) {
        process.stderr.write(
          '[validate-openspec-change] risk-shape-probe: skipped for archived target (archived changes are ' +
          'historical record; this probe is for pre-archive authoring). Not a failure.\n'
        );
      }

      if (exitCode === 0 && riskShapeProbeRequested && !isArchived) {
        const designMdMissing = hasProposal && !existsSync(ACTIVE_PATH_API.join(changeFolder, 'design.md'));
        const carrierRelPaths = listRiskShapeCarrierPaths({
          changeFolder,
          proposalPath,
          proposalMiniPath,
          hasProposal,
        }).map((absPath) => toGitPath(ACTIVE_PATH_API.relative(repoRoot, absPath), ACTIVE_PATH_API));
        if (!runRiskShapeProbe({ repoRoot, changeName, carrierRelPaths, designMdMissing })) {
          exitCode = 1;
        }
      }

      if (exitCode === 0 && tempRoot && !validateFlags.includes('--json')) {
        let detail;
        if (isArchived) {
          detail = `${changeRelPath}: archived target projected as ${changeName} in temp copy`;
        } else if (needsMiniShim) {
          detail = `${changeName}: proposal-mini.md shim validated in temp copy`;
        } else {
          detail = `${changeName}: Removed Scenarios canonical strip validated in temp copy`;
        }
        process.stderr.write(`[validate-openspec-change] ${detail}; worktree unchanged\n`);
      }
    }
  } finally {
    if (tempRoot && !process.env.DEVPRO_KEEP_OPENSPEC_VALIDATE_TMP) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }

  process.exit(exitCode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
