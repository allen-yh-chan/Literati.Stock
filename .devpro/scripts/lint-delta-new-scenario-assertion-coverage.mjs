#!/usr/bin/env node
/**
 * lint-delta-new-scenario-assertion-coverage.mjs
 *
 * Every delta `#### Scenario:` title that is new relative to canonical
 * (all ADDED requirement scenarios; MODIFIED supersets) MUST be hit by at
 * least one asserting carrier (`*.test.mjs` / related fixtures). Canonical-
 * zero-hit new scenarios with zero asserting coverage fail closed. Multi-pair
 * scenarios additionally get non-blocking explicit group-mapping warnings.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseRequirements } from './lint-spec-shall-must.mjs';
import { runChangeFolderLinterCli } from './lib/openspec-linter-cli.mjs';
import { consumerRootHasPositiveEvidence } from './lib/repo-identity.mjs';
import { neutraliseInertMarkdown } from './lib/markdown-fence-aware.mjs';

function stripScenarioPrefix(title) {
  return title.replace(/^Scenario:\s*/i, '').trim();
}

function collectDeltaBlocks(content) {
  const out = [];
  const blockRe = /^## (ADDED|MODIFIED) Requirements\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm;
  for (const match of content.matchAll(blockRe)) {
    out.push({ mode: match[1], block: match[2].replace(/\r\n/g, '\n') });
  }
  return out;
}

function scenarioTitlesFromReqs(reqs) {
  const titles = new Set();
  for (const req of reqs) {
    for (const sub of req.subSections) {
      if (sub.heading.startsWith('Scenario:')) {
        titles.add(stripScenarioPrefix(sub.heading));
      }
    }
  }
  return titles;
}

function whenThenGroups(text) {
  const groups = [];
  let pending = false;
  for (const line of neutraliseInertMarkdown(text).split('\n')) {
    if (/^\s*- \*\*WHEN\*\*/.test(line)) pending = true;
    if (pending && /^\s*- \*\*THEN\*\*/.test(line)) {
      groups.push(groups.length + 1);
      pending = false;
    }
  }
  return groups;
}

function collectNewScenarioTitles({ changeFolder, repoRoot }) {
  const specsDir = join(changeFolder, 'specs');
  const newTitles = [];
  if (!existsSync(specsDir) || !statSync(specsDir).isDirectory()) {
    return newTitles;
  }

  let caps;
  try {
    caps = readdirSync(specsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return newTitles;
  }

  for (const cap of caps) {
    const deltaSpecPath = join(specsDir, cap, 'spec.md');
    if (!existsSync(deltaSpecPath)) continue;
    let deltaContent;
    try {
      deltaContent = readFileSync(deltaSpecPath, 'utf8');
    } catch {
      continue;
    }

    const canonicalSpecPath = join(repoRoot, 'openspec', 'specs', cap, 'spec.md');
    let canonicalTitles = new Set();
    if (existsSync(canonicalSpecPath)) {
      try {
        const canonicalReqs = parseRequirements(readFileSync(canonicalSpecPath, 'utf8').replace(/\r\n/g, '\n'));
        canonicalTitles = scenarioTitlesFromReqs(canonicalReqs);
      } catch {
        canonicalTitles = new Set();
      }
    }

    for (const { mode, block } of collectDeltaBlocks(deltaContent)) {
      const deltaReqs = parseRequirements(block);
      const deltaTitles = scenarioTitlesFromReqs(deltaReqs);
      for (const title of deltaTitles) {
        const isNew = mode === 'ADDED' || !canonicalTitles.has(title);
        if (isNew) {
          const scenario = deltaReqs.flatMap(req => req.subSections)
            .find(sub => sub.heading.startsWith('Scenario:') && stripScenarioPrefix(sub.heading) === title);
          newTitles.push({ cap, mode, title, groups: whenThenGroups(scenario.text) });
        }
      }
    }
  }

  return newTitles;
}

function walkFiles(root, predicate, out = [], excludeDirectory = (_root, name) => name === 'node_modules' || name === '.git') {
  if (!existsSync(root)) return out;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = join(root, entry.name);
    if (entry.isDirectory()) {
      if (excludeDirectory(root, entry.name, entries)) continue;
      walkFiles(abs, predicate, out, excludeDirectory);
    } else if (entry.isFile() && predicate(abs, entry.name)) {
      out.push(abs);
    }
  }
  return out;
}

// Drop native candidates Git ignores, so an ignored scratch tree in a dirty checkout
// cannot satisfy coverage that a clean checkout would not have. `git check-ignore`
// reads the index: a tracked file stays even when an ignore pattern matches its path.
// Only applied when repoRoot itself is a Git checkout; a non-Git root (fixtures,
// exported trees) or a failing git keeps every candidate, as before.
function dropGitIgnored(repoRoot, files) {
  if (files.length === 0 || !existsSync(join(repoRoot, '.git'))) return files;
  const relPaths = files.map((abs) => relative(repoRoot, abs).replaceAll('\\', '/'));
  const res = spawnSync('git', ['-C', repoRoot, 'check-ignore', '--stdin', '-z'], {
    input: relPaths.join('\0'),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  // 0 = some ignored (listed on stdout), 1 = none ignored; anything else is a git failure.
  if (res.error || res.status !== 0) return files;
  const ignored = new Set(res.stdout.split('\0').filter(Boolean));
  return files.filter((_abs, index) => !ignored.has(relPaths[index]));
}

function collectAssertionCarriers(repoRoot, changeFolder) {
  const files = [];
  if (consumerRootHasPositiveEvidence(repoRoot)) {
    // Installed tooling tests belong to upstream. Search the consumer's native
    // test files, pruning managed/vendor/generated trees and never following links.
    const managedDirectories = new Set(['.git', 'node_modules', '.devpro', '.devpro-agent-rules', '.worktree', '.worktrees', '.claude', '.codex', '.cursor', '.opencode', '.agents', 'bin', 'obj']);
    const projectOutputDirectories = new Set(['vendor', 'build', 'dist', 'coverage', 'out', 'TestResults']);
    const nativeCandidates = walkFiles(repoRoot, (_abs, name) => /(?:\.spec\.ts|\.test\.ts|Tests\.cs)$/.test(name), [],
      (directory, name, entries) => {
        if (managedDirectories.has(name)) return true;
        if (directory === repoRoot && name === 'notes') return true;
        if (!projectOutputDirectories.has(name)) return false;
        // A business feature named vendor/coverage is still owned source. These
        // outputs are excluded only at a repository or declared project root.
        return directory === repoRoot || entries.some(entry => entry.isFile()
          && (entry.name === 'package.json' || entry.name.endsWith('.csproj')));
      });
    files.push(...dropGitIgnored(repoRoot, nativeCandidates));
  } else {
    // Preserve source/legacy carriers when no positive consumer evidence exists.
    walkFiles(
      join(repoRoot, '.devpro', 'scripts', 'tests'),
      (_abs, name) => name.endsWith('.mjs'),
      files,
    );
  }
  walkFiles(
    join(repoRoot, 'scenarios'),
    (_abs, name) => name.endsWith('.md') || name.endsWith('.mjs'),
    files,
  );
  // Change-folder prose (.md design/proposal/tasks/qa) is NOT an asserting carrier —
  // only machine fixtures (.mjs) under the change folder count, plus repo tests/scenarios.
  walkFiles(changeFolder, (abs, name) => {
    const rel = relative(changeFolder, abs).replaceAll('\\', '/');
    if (rel.startsWith('specs/')) return false;
    return name.endsWith('.mjs');
  }, files);
  return files;
}

function carrierAssertsTitle(content, title) {
  if (!title) return false;
  if (content.includes(title)) return true;
  if (content.includes(`Scenario: ${title}`)) return true;
  return false;
}

// Declarations in existing test/fixture carriers are intentionally not a semantic
// oracle. Qualified titles prevent another capability from claiming these groups.
function declaredGroups(carriers, entry) {
  const declared = new Set();
  const prefix = `[Scenario: ${entry.cap} :: ${entry.title}] [WhenThen: `;
  for (const { filePath, text } of carriers) {
    if (filePath.endsWith('.md')) continue;
    // Match the known title literally, including punctuation; only the numeric
    // suffix needs a grammar, so titles are never interpolated into a regex.
    for (const suffix of text.split(prefix).slice(1)) {
      const match = /^([1-9]\d*(?:\s*,\s*[1-9]\d*)*)\]/.exec(suffix);
      if (!match) continue;
      for (const number of match[1].split(',')) declared.add(Number(number.trim()));
    }
  }
  return declared;
}

/**
 * @param {{ changeFolder: string, repoRoot?: string }} opts
 * @returns {{ pass: boolean, violations: Array<{cap: string, mode: string, title: string}>, warnings?: Array<{cap: string, mode: string, title: string, missingGroups: number[]}>, error?: string }}
 */
export function lintDeltaNewScenarioAssertionCoverage({ changeFolder, repoRoot }) {
  const effectiveRepoRoot = repoRoot
    ? resolve(repoRoot)
    : resolve(changeFolder, '..', '..', '..');

  if (!existsSync(changeFolder) || !statSync(changeFolder).isDirectory()) {
    return { pass: false, violations: [], error: `change folder not found: ${changeFolder}` };
  }

  const newTitles = collectNewScenarioTitles({
    changeFolder: resolve(changeFolder),
    repoRoot: effectiveRepoRoot,
  });
  if (newTitles.length === 0) {
    return { pass: true, violations: [] };
  }

  const carriers = collectAssertionCarriers(effectiveRepoRoot, resolve(changeFolder));
  const carrierTexts = carriers.map((filePath) => {
    try {
      return { filePath, text: readFileSync(filePath, 'utf8') };
    } catch {
      return { filePath, text: '' };
    }
  });

  const violations = [];
  const warnings = [];
  for (const entry of newTitles) {
    const hit = carrierTexts.some(({ text }) => carrierAssertsTitle(text, entry.title));
    if (!hit) {
      const { cap, mode, title } = entry;
      violations.push({ cap, mode, title });
    }
    if (entry.groups.length > 1) {
      const declared = declaredGroups(carrierTexts, entry);
      const missingGroups = entry.groups.filter(group => !declared.has(group));
      if (missingGroups.length > 0) {
        const { cap, mode, title } = entry;
        warnings.push({ cap, mode, title, missingGroups });
      }
    }
  }

  return { pass: violations.length === 0, violations, ...(warnings.length ? { warnings } : {}) };
}

export function printDeltaScenarioClauseWarnings(result) {
  for (const warning of result.warnings ?? []) {
    process.stderr.write(
      `[lint-delta-new-scenario-assertion-coverage] warning: ${warning.cap} :: ${warning.mode} scenario "${warning.title}" `
      + `has unmapped WHEN/THEN groups ${warning.missingGroups.join(',')}. `
      + 'Add actual asserting tests with [Scenario: <capability> :: <bare title>] [WhenThen: 1,2]; marker presence is not semantic proof.\n',
    );
  }
}

export function printDeltaNewScenarioAssertionCoverageViolations(result) {
  if (result.error) {
    process.stderr.write(`[lint-delta-new-scenario-assertion-coverage] ${result.error}\n`);
    return;
  }
  for (const v of result.violations) {
    process.stderr.write(
      `[lint-delta-new-scenario-assertion-coverage] ${v.cap} :: ${v.mode} scenario "${v.title}" `
      + 'has no asserting test/lint fixture hit (new relative to canonical).\n',
    );
  }
  process.stderr.write(
    '\nFix: add a focused test or lint fixture that names/asserts this scenario title '
    + '(literal or `Scenario: <title>`), then re-run validate --strict.\n',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runChangeFolderLinterCli({
    scriptName: 'lint-delta-new-scenario-assertion-coverage',
    usage:
      'Usage: node lint-delta-new-scenario-assertion-coverage.mjs <change-folder>\n'
      + '  <change-folder>  path to openspec/changes/<name>',
    lint: ({ changeFolder }) => lintDeltaNewScenarioAssertionCoverage({ changeFolder }),
    printViolation(result) {
      printDeltaScenarioClauseWarnings(result);
      printDeltaNewScenarioAssertionCoverageViolations(result);
    },
    onPass(result, { changeFolder }) {
      printDeltaScenarioClauseWarnings(result);
      console.log(`[lint-delta-new-scenario-assertion-coverage] ${changeFolder}: pass`);
    },
  });
}
