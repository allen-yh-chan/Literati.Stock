#!/usr/bin/env node
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseRequirements } from './lint-spec-shall-must.mjs';
import { collectRemovedScenarios } from './lib/removed-scenarios.mjs';
import { runChangeFolderLinterCli } from './lib/openspec-linter-cli.mjs';
import { closesFence, fenceDelimiter } from './lib/markdown-fence-aware.mjs';

const REMOVED_SCENARIOS_HEADING = '## Removed Scenarios';
const AUTHORIZED_REMOVED_SCENARIO_FILES = [
  'proposal.md',
  'proposal-mini.md',
  'tasks.md',
  'decisions.md',
];

/** Remediation text shared by the lint CLI and validate-openspec-change.mjs. */
export const SCENARIO_FIX_HINT =
  '\nFix: for a MODIFIED Requirement, restore the missing scenario(s) in the delta MODIFIED block.\n' +
  'For a REMOVED Requirement, either retain the scenario in an ADDED or MODIFIED Requirement of this delta,\n' +
  'or declare the intentional removal in proposal.md / proposal-mini.md / tasks.md / decisions.md:\n' +
  '\n' +
  `  ${REMOVED_SCENARIOS_HEADING}\n` +
  '  - "<scenario title>"\n' +
  '\n' +
  'The declaration MUST be the bare title (the text after `#### Scenario:`). A `Scenario: ` prefix is NOT honored,\n' +
  'because gate (i) compares bare titles exactly and would block after archive.\n' +
  'MUST NOT declare only inside specs/**/spec.md (delta-local is rejected).\n' +
  'This is a pre-archive guard (mirrors gate (i) escape-hatch semantics).\n' +
  'gate (i) in pre-pr-archive-gate.mjs remains the post-archive canonical guard.\n';

/** Delta-local `## Removed Scenarios` rejection text, shared with validate-openspec-change.mjs. */
export function formatLocationError(scriptName, loc) {
  return `[${scriptName}] ${loc.cap} :: delta-local "${REMOVED_SCENARIOS_HEADING}" at ${loc.path}\n` +
    `  Delta-local declarations are NOT honored by gate (i) / collectRemovedScenarios.\n` +
    `  Move the hatch to one of: ${AUTHORIZED_REMOVED_SCENARIO_FILES.join(' / ')} and remove the heading from the delta.\n`;
}

/**
 * Bare scenario title: the text after `Scenario:` — exactly what gate (i) in
 * pre-pr-archive-gate.mjs extracts with /^#### Scenario:\s*(.+?)\s*$/.
 * @param {string} heading - e.g. "Scenario: Invalid Input"
 */
export function bareScenarioTitle(heading) {
  return heading.replace(/^Scenario:\s*/, '').trim();
}

/**
 * The one authorization comparison for both the MODIFIED and the REMOVED path:
 * exact bare-title equality, as gate (i) applies after archive. A declaration
 * carrying a `Scenario: ` prefix therefore authorizes nothing.
 * @param {string} bareTitle
 * @param {Set<string>} removedDeclared
 */
function isDeclaredRemoved(bareTitle, removedDeclared) {
  return removedDeclared.has(bareTitle);
}

/** Bodies of every `## <kind> Requirements` block of a delta (CRLF normalized). */
function extractDeltaBlocks(deltaContent, kind) {
  const blockRe = new RegExp(`^## ${kind} Requirements\\r?\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'gm');
  return [...deltaContent.matchAll(blockRe)].map(m => m[1].replace(/\r\n/g, '\n'));
}

/**
 * Line-anchored scan for a standalone `## Removed Scenarios` heading.
 * Skips fenced code blocks (CommonMark rules via lib/markdown-fence-aware.mjs) and inline code spans.
 * @param {string} text
 * @returns {boolean}
 */
export function deltaContainsRemovedScenariosHeading(text) {
  const lines = String(text).replaceAll('\r\n', '\n').split('\n');
  let open = null;
  for (const line of lines) {
    const delim = fenceDelimiter(line);
    if (open !== null) {
      if (delim && closesFence(delim, open)) open = null;
      continue;
    }
    if (delim) {
      open = delim;
      continue;
    }
    // Strip inline code spans before heading match so ``## Removed Scenarios`` does not trip.
    const withoutInline = line.replace(/`[^`]*`/gu, '');
    if (/^## Removed Scenarios\s*$/u.test(withoutInline.trimEnd())) {
      return true;
    }
  }
  return false;
}

/**
 * Extract scenario title set from a list of parsed requirements.
 * Returns a Map<reqName, Set<headingString>> where headingString is the
 * full heading (e.g. "Scenario: Foo Bar").
 *
 * @param {Array} reqs - result of parseRequirements()
 * @returns {Map<string, Set<string>>}
 */
function buildScenarioMap(reqs) {
  const map = new Map();
  for (const req of reqs) {
    const scenarios = new Set(
      req.subSections
        .filter(s => s.heading.startsWith('Scenario:'))
        .map(s => s.heading)
    );
    map.set(req.name, scenarios);
  }
  return map;
}

/**
 * Read `openspec/specs/<cap>/spec.md` as it was at `baseRef`. An absent path at
 * the base is not an error (the capability is new in this change); every other
 * git failure is, so the base-aware check never silently degrades.
 *
 * @returns {{ content: string } | { error: string }}
 */
function readCanonicalAtRef({ repoRoot, baseRef, cap }) {
  const relativePath = `openspec/specs/${cap}/spec.md`;
  const run = args => execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const present = run(['ls-tree', '-z', '--name-only', baseRef, '--', relativePath])
      .split('\0')
      .filter(Boolean)
      .includes(relativePath);
    if (!present) return { content: '' };
  } catch (error) {
    return { error: `unable to inspect canonical spec at ${baseRef}: ${relativePath}: ${error.message}` };
  }
  try {
    return { content: run(['show', `${baseRef}:${relativePath}`]) };
  } catch (error) {
    return { error: `unable to read canonical spec at ${baseRef}: ${relativePath}: ${error.message}` };
  }
}

/**
 * Core lint function. Checks that each MODIFIED Requirement in each delta spec
 * preserves all scenarios from the corresponding canonical Requirement, and that
 * every scenario of a REMOVED Requirement is either retained in the post-promotion
 * set (ADDED / MODIFIED / untouched canonical Requirements) or declared in
 * "## Removed Scenarios". Declarations match by exact bare title (gate (i)).
 *
 * @param {object} opts
 * @param {string} opts.changeFolder - absolute path to the active change folder
 *   (e.g. openspec/changes/<name>)
 * @param {string} [opts.repoRoot] - absolute path to repo root (openspec/ parent).
 *   If omitted, derived from changeFolder by going up two levels.
 * @param {string} [opts.baseRef] - immutable change-base Git ref (#2978). The
 *   expected scenario set of each MODIFIED Requirement becomes the union of the
 *   current canonical scenarios and the canonical scenarios at that ref. Without
 *   it a scenario renamed on BOTH sides in one change has nothing to compare
 *   against, because delta and canonical are required to reach the same final
 *   state; with it the old title is still expected, so the rename needs a
 *   `## Removed Scenarios` declaration like any other removal.
 * @returns {{ pass: boolean, violations: Array<{cap, requirement, missing: string[], removedUndeclared?: string[], fromBase?: string[]}>, locationErrors?: Array<{cap, path}>, error?: string }}
 */
export function lintModifiedScenarioPreservation({ changeFolder, repoRoot, baseRef }) {
  // Derive repoRoot if not provided: changeFolder is openspec/changes/<name>
  // so repoRoot = changeFolder/../../.. (<name> → changes → openspec → root)
  const effectiveRepoRoot = repoRoot
    ? resolve(repoRoot)
    : resolve(changeFolder, '..', '..', '..');

  // Verify changeFolder exists
  if (!existsSync(changeFolder) || !statSync(changeFolder).isDirectory()) {
    return { pass: false, violations: [], error: `change folder not found: ${changeFolder}` };
  }

  // null / undefined = no base supplied (legacy comparison). Anything else must be
  // a resolvable ref: an empty or non-string value is a supplied-but-unusable anchor
  // and must fail closed, not silently fall back to the legacy comparison.
  const baseSupplied = baseRef !== undefined && baseRef !== null;
  if (baseSupplied) {
    if (typeof baseRef !== 'string' || baseRef === '') {
      return { pass: false, violations: [], error: `invalid change base ref: ${JSON.stringify(baseRef)}` };
    }
    try {
      execFileSync('git', ['rev-parse', '--verify', `${baseRef}^{commit}`], {
        cwd: effectiveRepoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      return { pass: false, violations: [], error: `invalid change base ref: ${baseRef}` };
    }
  }

  // Active change only — MUST NOT scan openspec/changes/archive/**
  const relChange = relative(join(effectiveRepoRoot, 'openspec', 'changes'), changeFolder)
    .split(/[/\\]/u)
    .join('/');
  if (relChange === 'archive' || relChange.startsWith('archive/')) {
    return {
      pass: false,
      violations: [],
      error: `refusing to lint archive path (active changes only): ${changeFolder}`,
    };
  }

  // Find specs/ directory in change folder
  const specsDir = join(changeFolder, 'specs');
  if (!existsSync(specsDir) || !statSync(specsDir).isDirectory()) {
    // No specs directory — nothing to check
    return { pass: true, violations: [] };
  }

  // Collect removed scenarios escape-hatch declarations from the change folder
  const removedDeclared = collectRemovedScenarios(changeFolder);

  const violations = [];
  const locationErrors = [];

  // Walk each capability directory under specs/
  let caps;
  try {
    caps = readdirSync(specsDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch {
    return { pass: true, violations: [] };
  }

  for (const cap of caps) {
    const deltaSpecPath = join(specsDir, cap, 'spec.md');
    if (!existsSync(deltaSpecPath)) continue; // graceful skip

    let deltaContent;
    try {
      deltaContent = readFileSync(deltaSpecPath, 'utf8');
    } catch {
      continue;
    }

    // #2658 / D5 / F4: active delta standalone heading → fail even if four-file declares.
    if (deltaContainsRemovedScenariosHeading(deltaContent)) {
      locationErrors.push({
        cap,
        path: relative(effectiveRepoRoot, deltaSpecPath).split(/[/\\]/u).join('/'),
      });
      continue;
    }

    // Canonical spec path: repoRoot/openspec/specs/<cap>/spec.md
    const canonicalSpecPath = join(effectiveRepoRoot, 'openspec', 'specs', cap, 'spec.md');
    let canonicalContent = '';
    if (existsSync(canonicalSpecPath)) {
      try {
        canonicalContent = readFileSync(canonicalSpecPath, 'utf8');
      } catch {
        continue; // graceful skip on read error
      }
    }

    // Canonical spec at the change base (base-aware mode only; '' = absent there).
    let baseCanonicalContent = '';
    if (baseSupplied) {
      const baseRead = readCanonicalAtRef({ repoRoot: effectiveRepoRoot, baseRef, cap });
      if (baseRead.error) return { pass: false, violations, error: baseRead.error };
      baseCanonicalContent = baseRead.content;
    }
    if (canonicalContent === '' && baseCanonicalContent === '') continue; // new capability — graceful skip

    const modifiedBlocks = extractDeltaBlocks(deltaContent, 'MODIFIED');
    const removedBlocks = extractDeltaBlocks(deltaContent, 'REMOVED');

    if (modifiedBlocks.length === 0 && removedBlocks.length === 0) continue; // nothing to check — skip this cap

    // Parse all MODIFIED / REMOVED Requirements from the delta
    const allDeltaReqs = modifiedBlocks.flatMap(block => parseRequirements(block));
    const deltaScenarioMap = buildScenarioMap(allDeltaReqs);
    const removedReqs = removedBlocks.flatMap(block => parseRequirements(block));

    // --- Canonical: parse full spec (no stripping needed per proposal-mini) ---
    const canonicalReqs = parseRequirements(canonicalContent);
    const canonicalScenarioMap = buildScenarioMap(canonicalReqs);
    const baseScenarioMap = buildScenarioMap(parseRequirements(baseCanonicalContent));

    // Expected set: current canonical first, then scenarios that only the
    // change base had (a title renamed or dropped by this change's own edits).
    const expectedFor = reqName => {
      const currentScenarios = canonicalScenarioMap.get(reqName) ?? new Set();
      const baseOnlyScenarios = [...(baseScenarioMap.get(reqName) ?? [])].filter(t => !currentScenarios.has(t));
      return { baseOnlyScenarios, expectedScenarios: [...currentScenarios, ...baseOnlyScenarios] };
    };

    // --- Compare: for each MODIFIED Requirement in delta ---
    for (const [reqName, deltaScenarios] of deltaScenarioMap) {
      if (!canonicalScenarioMap.has(reqName) && !baseScenarioMap.has(reqName)) {
        // Canonical has no matching Requirement — skip (not this lint's responsibility)
        continue;
      }

      const { baseOnlyScenarios, expectedScenarios } = expectedFor(reqName);

      // Find missing: canonical (now or at the base) has it, delta doesn't
      const missing = [];
      for (const canonScenario of expectedScenarios) {
        if (deltaScenarios.has(canonScenario)) continue; // present — ok
        if (!isDeclaredRemoved(bareScenarioTitle(canonScenario), removedDeclared)) {
          missing.push(canonScenario);
        }
      }

      if (missing.length > 0) {
        const violation = { cap, requirement: reqName, missing };
        const fromBase = missing.filter(t => baseOnlyScenarios.includes(t));
        if (fromBase.length > 0) violation.fromBase = fromBase;
        violations.push(violation);
      }
    }

    if (removedReqs.length === 0) continue;

    // --- REMOVED Requirements: simulate the post-promotion bare-title set (gate (i)) ---
    const removedNames = new Set(removedReqs.map(r => r.name));
    const modifiedNames = new Set(allDeltaReqs.map(r => r.name));
    const addedReqs = extractDeltaBlocks(deltaContent, 'ADDED').flatMap(block => parseRequirements(block));
    const promoted = new Set();
    const collectBare = req => {
      for (const sub of req.subSections) {
        if (sub.heading.startsWith('Scenario:')) promoted.add(bareScenarioTitle(sub.heading));
      }
    };
    for (const req of canonicalReqs) {
      if (!removedNames.has(req.name) && !modifiedNames.has(req.name)) collectBare(req);
    }
    for (const req of [...addedReqs, ...allDeltaReqs]) collectBare(req);

    for (const reqName of removedNames) {
      if (!canonicalScenarioMap.has(reqName) && !baseScenarioMap.has(reqName)) continue; // lint-delta-requirement-mode owns this
      const { baseOnlyScenarios, expectedScenarios } = expectedFor(reqName);
      const baseOnlyBare = new Set(baseOnlyScenarios.map(bareScenarioTitle));
      const removedUndeclared = [];
      for (const bare of new Set(expectedScenarios.map(bareScenarioTitle))) {
        if (promoted.has(bare) || isDeclaredRemoved(bare, removedDeclared)) continue;
        removedUndeclared.push(bare);
      }
      if (removedUndeclared.length > 0) {
        const violation = { cap, requirement: reqName, missing: [], removedUndeclared };
        const fromBase = removedUndeclared.filter(t => baseOnlyBare.has(t));
        if (fromBase.length > 0) violation.fromBase = fromBase;
        violations.push(violation);
      }
    }
  }

  const pass = violations.length === 0 && locationErrors.length === 0;
  return { pass, violations, locationErrors };
}

// CLI entry
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runChangeFolderLinterCli({
    scriptName: 'lint-modified-scenario-preservation',
    usage:
      'Usage: node lint-modified-scenario-preservation.mjs <change-folder> [--base <change-base-ref>]\n' +
      '  <change-folder>  path to openspec/changes/<name>\n' +
      '  --base           immutable Git ref captured when the change branch was created;\n' +
      '                   also expects the scenarios canonical had at that ref (#2978)',
    parseExtraArgs(argv) {
      let baseRef;
      for (let index = 3; index < argv.length; index++) {
        if (argv[index] === '--base' && index + 1 < argv.length) {
          baseRef = argv[++index];
          continue;
        }
        console.error(`[lint-modified-scenario-preservation] unknown or incomplete argument: ${argv[index]}`);
        process.exit(1);
      }
      return { baseRef };
    },
    lint: ({ changeFolder, baseRef }) => lintModifiedScenarioPreservation({ changeFolder, baseRef }),
    printViolation(result, { extra }) {
      for (const loc of result.locationErrors ?? []) {
        process.stderr.write(formatLocationError('lint-modified-scenario-preservation', loc));
      }
      for (const v of result.violations) {
        const baseNote = title => v.fromBase?.includes(title)
          ? ` (present in canonical at ${extra.baseRef}, absent from current canonical: renamed or dropped in this change)`
          : '';
        for (const title of v.missing) {
          process.stderr.write(
            `[lint-modified-scenario-preservation] ${v.cap} :: Requirement "${v.requirement}" :: missing scenario "${bareScenarioTitle(title)}"${baseNote(title)}\n`
          );
        }
        for (const title of v.removedUndeclared ?? []) {
          process.stderr.write(
            `[lint-modified-scenario-preservation] ${v.cap} :: Requirement "${v.requirement}" :: removed scenario "${title}" not declared${baseNote(title)}\n`
          );
        }
      }
      process.stderr.write(SCENARIO_FIX_HINT);
    },
    onPass(_result, { changeFolder }) {
      console.log(`[lint-modified-scenario-preservation] ${changeFolder}: pass`);
    },
  });
}
