import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { lintDeltaNewScenarioAssertionCoverage } from '../lint-delta-new-scenario-assertion-coverage.mjs';

function buildTempChange({ scenarioTitle, withAssertingTest }) {
  const root = mkdtempSync(join(tmpdir(), 'delta-scenario-coverage-'));
  const changeFolder = join(root, 'openspec', 'changes', 'coverage-fixture');
  mkdirSync(join(changeFolder, 'specs', 'demo'), { recursive: true });
  mkdirSync(join(root, 'openspec', 'specs', 'demo'), { recursive: true });
  mkdirSync(join(root, '.devpro', 'scripts', 'tests'), { recursive: true });

  writeFileSync(
    join(root, 'openspec', 'specs', 'demo', 'spec.md'),
    [
      '# demo',
      '',
      '### Requirement: Existing Capability',
      '',
      'Canonical body.',
      '',
      '#### Scenario: Already Covered Canonical Scenario',
      '',
      '- **WHEN** canonical',
      '- **THEN** covered',
      '',
    ].join('\n'),
    'utf8',
  );

  writeFileSync(
    join(changeFolder, 'specs', 'demo', 'spec.md'),
    [
      '## ADDED Requirements',
      '',
      '### Requirement: Brand New Coverage Requirement',
      '',
      'New body.',
      '',
      `#### Scenario: ${scenarioTitle}`,
      '',
      '- **WHEN** new',
      '- **THEN** asserted or not',
      '',
    ].join('\n'),
    'utf8',
  );

  if (withAssertingTest) {
    writeFileSync(
      join(root, '.devpro', 'scripts', 'tests', 'coverage-fixture.test.mjs'),
      `import assert from "node:assert/strict";\ntest("asserts ${scenarioTitle}", () => { assert.ok(true); });\n`,
      'utf8',
    );
  }

  return { root, changeFolder };
}

test('New scenario without asserting coverage fails strict', () => {
  const title = 'Unique Unasserted Scenario Title ZZ-9';
  const { root, changeFolder } = buildTempChange({ scenarioTitle: title, withAssertingTest: false });
  try {
    const result = lintDeltaNewScenarioAssertionCoverage({ changeFolder, repoRoot: root });
    assert.equal(result.pass, false);
    assert.ok(result.violations.some((v) => v.title === title));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('New scenario with asserting coverage passes the coverage check', () => {
  const title = 'Unique Asserted Scenario Title AA-1';
  const { root, changeFolder } = buildTempChange({ scenarioTitle: title, withAssertingTest: true });
  try {
    const result = lintDeltaNewScenarioAssertionCoverage({ changeFolder, repoRoot: root });
    assert.equal(result.pass, true, JSON.stringify(result.violations));
    assert.deepEqual(result.violations, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('New scenario mentioned only in change-folder prose md still fails coverage', () => {
  const title = 'Prose-Only Mention Scenario Title BB-2';
  const { root, changeFolder } = buildTempChange({ scenarioTitle: title, withAssertingTest: false });
  try {
    writeFileSync(
      join(changeFolder, 'design.md'),
      `# Design\n\nMentions #### Scenario: ${title} in prose only.\n`,
      'utf8',
    );
    const result = lintDeltaNewScenarioAssertionCoverage({ changeFolder, repoRoot: root });
    assert.equal(result.pass, false, 'prose-only design.md must not count as asserting coverage');
    assert.ok(result.violations.some((v) => v.title === title));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


function addConsumerEvidence(root) {
  mkdirSync(join(root, '.devpro-agent-rules', '.devpro', 'scripts'), { recursive: true });
  writeFileSync(join(root, '.devpro-agent-rules', 'AGENTS.md'), '# Installed rules\n');
  writeFileSync(join(root, '.devpro-agent-rules', '.devpro', 'scripts', 'sync-agent-rules.mjs'), '// upstream sync\n');
}

for (const carrier of ['src/app/widget.spec.ts', 'src/app/widget.test.ts', 'tests/ServiceTests.cs']) {
  test('Consumer native test carrier covers new scenario: ' + carrier, () => {
    const title = 'Consumer Native Test Scenario';
    const { root, changeFolder } = buildTempChange({ scenarioTitle: title, withAssertingTest: false });
    try {
      addConsumerEvidence(root);
      const file = join(root, carrier);
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, '// ' + title + '\n');
      assert.deepEqual(lintDeltaNewScenarioAssertionCoverage({ changeFolder, repoRoot: root }), { pass: true, violations: [] });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test('Consumer excludes vendored upstream tests from scenario coverage', () => {
  const title = 'Vendored Upstream Only Scenario';
  const { root, changeFolder } = buildTempChange({ scenarioTitle: title, withAssertingTest: true });
  try {
    addConsumerEvidence(root);
    const result = lintDeltaNewScenarioAssertionCoverage({ changeFolder, repoRoot: root });
    assert.equal(result.pass, false);
    assert.deepEqual(result.violations.map(v => v.title), [title]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Consumer ignores managed, dependency, worktree and generated native tests', () => {
  const title = 'Excluded Native Test Scenario';
  for (const carrier of ['.devpro/scripts/tests/tool.spec.ts', '.devpro-agent-rules/tests/upstream.test.ts', 'node_modules/pkg/native.spec.ts', '.worktree/other/src/native.test.ts', 'project/obj/GeneratedTests.cs', 'project/bin/GeneratedTests.cs', 'dist/native.spec.ts', 'vendor/pkg/native.spec.ts', '.worktrees/other/native.spec.ts', 'build/native.spec.ts', 'coverage/native.spec.ts', '.claude/worktrees/other/native.spec.ts', 'notes/tmp/native.spec.ts', 'out/native.spec.ts', 'TestResults/ResultTests.cs', 'packages/ui/dist/native.spec.ts', 'projects/server/out/GeneratedTests.cs']) {
    const { root, changeFolder } = buildTempChange({ scenarioTitle: title, withAssertingTest: false });
    try {
      addConsumerEvidence(root);
      for (const [directory, marker] of [['packages/ui', 'package.json'], ['projects/server', 'Server.csproj']]) {
        if (carrier.startsWith(directory + '/')) {
          mkdirSync(join(root, directory), { recursive: true });
          writeFileSync(join(root, directory, marker), marker.endsWith('.json') ? '{}' : '<Project />');
        }
      }
      const file = join(root, carrier);
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, '// ' + title + '\n');
      assert.equal(lintDeltaNewScenarioAssertionCoverage({ changeFolder, repoRoot: root }).pass, false, carrier);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('Consumer retains explicit change machine fixtures and scenario carriers', () => {
  for (const carrier of ['openspec/changes/coverage-fixture/check.mjs', 'scenarios/check.md']) {
    const title = 'Consumer Explicit Scenario Carrier';
    const { root, changeFolder } = buildTempChange({ scenarioTitle: title, withAssertingTest: false });
    try {
      addConsumerEvidence(root);
      const file = join(root, carrier);
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, '// ' + title + '\n');
      assert.equal(lintDeltaNewScenarioAssertionCoverage({ changeFolder, repoRoot: root }).pass, true, carrier);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('Consumer native files without a title match fail coverage', () => {
  const title = 'Unmatched Consumer Scenario';
  const { root, changeFolder } = buildTempChange({ scenarioTitle: title, withAssertingTest: false });
  try {
    addConsumerEvidence(root);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'widget.spec.ts'), '// another scenario\n');
    writeFileSync(join(root, 'src', 'ordinary.ts'), '// ' + title + '\n');
    assert.equal(lintDeltaNewScenarioAssertionCoverage({ changeFolder, repoRoot: root }).pass, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('Consumer native test discovery does not follow symlinked directories or files', (t) => {
  const title = 'Linked Native Scenario';
  const { root, changeFolder } = buildTempChange({ scenarioTitle: title, withAssertingTest: false });
  const external = mkdtempSync(join(tmpdir(), 'delta-external-tests-'));
  try {
    addConsumerEvidence(root);
    writeFileSync(join(external, 'linked.spec.ts'), '// ' + title + '\n');
    try {
      symlinkSync(external, join(root, 'linked-tests'), 'dir');
      symlinkSync(join(external, 'linked.spec.ts'), join(root, 'linked.test.ts'), 'file');
    } catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) {
        t.skip('Windows host cannot create symlinks');
        return;
      }
      throw error;
    }
    assert.equal(lintDeltaNewScenarioAssertionCoverage({ changeFolder, repoRoot: root }).pass, false);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(external, { recursive: true, force: true }); }
});

test('Declared consumer installation also selects owned native tests', () => {
  const title = 'Declared Consumer Scenario';
  const { root, changeFolder } = buildTempChange({ scenarioTitle: title, withAssertingTest: true });
  try {
    writeFileSync(join(root, '.gitmodules'), '[submodule "rules"]\n path = .devpro-agent-rules\n');
    writeFileSync(join(root, '.devpro', 'scripts', 'sync-agent-rules.mjs'), '// sync\n');
    writeFileSync(join(root, '.devpro', 'scripts', 'devpro-doctor.mjs'), '// doctor\n');
    assert.equal(lintDeltaNewScenarioAssertionCoverage({ changeFolder, repoRoot: root }).pass, false);
    mkdirSync(join(root, 'tests'), { recursive: true });
    writeFileSync(join(root, 'tests', 'DeclaredTests.cs'), '// ' + title + '\n');
    assert.equal(lintDeltaNewScenarioAssertionCoverage({ changeFolder, repoRoot: root }).pass, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('Consumer business directories named vendor, build, dist or coverage remain eligible', () => {
  const title = 'Consumer Business Directory Collision';
  for (const folder of ['vendor', 'build', 'dist', 'coverage']) {
    const { root, changeFolder } = buildTempChange({ scenarioTitle: title, withAssertingTest: false });
    try {
      addConsumerEvidence(root);
      const directory = join(root, 'src', 'app', folder);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'feature.spec.ts'), '// ' + title + '\n');
      assert.equal(lintDeltaNewScenarioAssertionCoverage({ changeFolder, repoRoot: root }).pass, true, folder);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

function initGitRepo(root) {
  const git = (...args) => {
    const res = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
  };
  git('init', '-q');
  return git;
}

test('Consumer native tests ignored by Git do not count as scenario coverage', () => {
  const title = 'Git Ignored Scratch Scenario';
  for (const [ignoreLine, carrier] of [['scratch/', 'scratch/run-1/native.spec.ts'], ['*.local.spec.ts', 'src/app/widget.local.spec.ts']]) {
    const { root, changeFolder } = buildTempChange({ scenarioTitle: title, withAssertingTest: false });
    try {
      addConsumerEvidence(root);
      initGitRepo(root);
      writeFileSync(join(root, '.gitignore'), ignoreLine + '\n');
      const file = join(root, carrier);
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, '// ' + title + '\n');
      const result = lintDeltaNewScenarioAssertionCoverage({ changeFolder, repoRoot: root });
      assert.equal(result.pass, false, carrier);
      assert.deepEqual(result.violations.map(v => v.title), [title]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('Consumer owned native tests in a Git repo still cover the scenario: untracked and tracked', () => {
  const title = 'Git Owned Native Scenario';
  // Untracked but not ignored: a test the author has not staged yet.
  {
    const { root, changeFolder } = buildTempChange({ scenarioTitle: title, withAssertingTest: false });
    try {
      addConsumerEvidence(root);
      initGitRepo(root);
      writeFileSync(join(root, '.gitignore'), 'scratch/\n');
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'widget.spec.ts'), '// ' + title + '\n');
      assert.deepEqual(lintDeltaNewScenarioAssertionCoverage({ changeFolder, repoRoot: root }), { pass: true, violations: [] });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  // Tracked although an ignore pattern matches its path: a clean checkout has it too.
  {
    const { root, changeFolder } = buildTempChange({ scenarioTitle: title, withAssertingTest: false });
    try {
      addConsumerEvidence(root);
      const git = initGitRepo(root);
      writeFileSync(join(root, '.gitignore'), 'scratch/\n');
      mkdirSync(join(root, 'scratch'), { recursive: true });
      writeFileSync(join(root, 'scratch', 'kept.spec.ts'), '// ' + title + '\n');
      git('add', '-f', 'scratch/kept.spec.ts');
      assert.deepEqual(lintDeltaNewScenarioAssertionCoverage({ changeFolder, repoRoot: root }), { pass: true, violations: [] });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});


function multiPairFixture(markers = '') {
  const title = 'Retry after releasing the record';
  const fixture = buildTempChange({ scenarioTitle: title, withAssertingTest: true });
  const spec = join(fixture.changeFolder, 'specs', 'demo', 'spec.md');
  writeFileSync(spec, readFileSync(spec, 'utf8') + '\n- **WHEN** retry leaves residue\n- **THEN** reject the retry\n');
  writeFileSync(join(fixture.root, '.devpro', 'scripts', 'tests', 'coverage-fixture.test.mjs'),
    `test("${title} ${markers}", () => { assert.ok(true); });\n`);
  return { ...fixture, title, spec };
}

// Marker discovery is advisory evidence, never an assertion/semantic oracle.
test('Partial WHEN/THEN mapping warns about the second group without blocking', () => {
  const f = multiPairFixture('[Scenario: demo :: Retry after releasing the record] [WhenThen: 1]');
  try {
    const result = lintDeltaNewScenarioAssertionCoverage({ changeFolder: f.changeFolder, repoRoot: f.root });
    assert.equal(result.pass, true);
    assert.deepEqual(result.violations, []);
    assert.deepEqual(result.warnings, [{ cap: 'demo', mode: 'ADDED', title: f.title, missingGroups: [2] }]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('Unmapped multi-pair scenario warns about both groups', () => {
  const f = multiPairFixture();
  try {
    const result = lintDeltaNewScenarioAssertionCoverage({ changeFolder: f.changeFolder, repoRoot: f.root });
    assert.deepEqual(result.warnings?.[0].missingGroups, [1, 2]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('One test may declare both WHEN/THEN groups', () => {
  const f = multiPairFixture('[Scenario: demo :: Retry after releasing the record] [WhenThen: 1,2]');
  try {
    assert.deepEqual(lintDeltaNewScenarioAssertionCoverage({ changeFolder: f.changeFolder, repoRoot: f.root }), { pass: true, violations: [] });
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('Separate test carriers may jointly map the groups', () => {
  const f = multiPairFixture('[Scenario: demo :: Retry after releasing the record] [WhenThen: 1]');
  try {
    writeFileSync(join(f.root, '.devpro', 'scripts', 'tests', 'retry.test.mjs'),
      `test('[Scenario: demo :: ${f.title}] [WhenThen: 2]', () => assert.ok(true));`);
    assert.equal(lintDeltaNewScenarioAssertionCoverage({ changeFolder: f.changeFolder, repoRoot: f.root }).warnings, undefined);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('Other capabilities and unrelated test counts do not map the missing group', () => {
  const f = multiPairFixture('[Scenario: other :: Retry after releasing the record] [WhenThen: 1,2]');
  try {
    writeFileSync(join(f.root, '.devpro', 'scripts', 'tests', 'unrelated.test.mjs'),
      Array.from({ length: 20 }, (_, i) => `test('unrelated ${i}', () => assert.ok(true));`).join('\n'));
    assert.deepEqual(lintDeltaNewScenarioAssertionCoverage({ changeFolder: f.changeFolder, repoRoot: f.root }).warnings?.[0].missingGroups, [1, 2]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

for (const carrier of ['prose', 'tasks']) {
  test(`${carrier}-only Markdown cannot satisfy WHEN/THEN group mappings`, () => {
    const f = multiPairFixture();
    try {
      const marker = `[Scenario: demo :: ${f.title}] [WhenThen: 1,2]`;
      if (carrier === 'prose') {
        mkdirSync(join(f.root, 'scenarios'));
        writeFileSync(join(f.root, 'scenarios', 'prose.md'), marker);
      } else writeFileSync(join(f.changeFolder, 'tasks.md'), marker);
      rmSync(join(f.root, '.devpro', 'scripts', 'tests', 'coverage-fixture.test.mjs'));
      const result = lintDeltaNewScenarioAssertionCoverage({ changeFolder: f.changeFolder, repoRoot: f.root });
      assert.equal(result.pass, carrier === 'prose');
      assert.deepEqual(result.violations, carrier === 'prose' ? [] : [{ cap: 'demo', mode: 'ADDED', title: f.title }]);
      assert.deepEqual(result.warnings?.[0].missingGroups, [1, 2]);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}

test('AND outcomes and fenced examples do not create extra WHEN/THEN groups', () => {
  const f = multiPairFixture('[Scenario: demo :: Retry after releasing the record] [WhenThen: 1]');
  try {
    writeFileSync(f.spec, (readFileSync(f.spec, 'utf8') + '\n- **AND** keep the record\n```md\n- **WHEN** example only\n- **THEN** example only\n```\n').replaceAll('\n', '\r\n'));
    assert.deepEqual(lintDeltaNewScenarioAssertionCoverage({ changeFolder: f.changeFolder, repoRoot: f.root }).warnings?.[0].missingGroups, [2]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('Standalone CLI prints missing-group warning but exits zero', () => {
  const f = multiPairFixture('[Scenario: demo :: Retry after releasing the record] [WhenThen: 1]');
  try {
    const result = spawnSync(process.execPath,
      [fileURLToPath(new URL('../lint-delta-new-scenario-assertion-coverage.mjs', import.meta.url)), f.changeFolder],
      { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /warning:.*Retry after releasing the record.*WHEN\/THEN groups 2/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});


test('Literal bracket punctuation in a scenario title retains its group mapping', () => {
  const f = multiPairFixture();
  const title = 'Retry [residue]：再次嘗試';
  try {
    writeFileSync(f.spec, readFileSync(f.spec, 'utf8').replace(f.title, title));
    writeFileSync(join(f.root, '.devpro', 'scripts', 'tests', 'coverage-fixture.test.mjs'),
      `test('[Scenario: demo :: ${title}] [WhenThen: 1,2]', () => assert.ok(true));`);
    assert.equal(lintDeltaNewScenarioAssertionCoverage({ changeFolder: f.changeFolder, repoRoot: f.root }).warnings, undefined);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});


for (const eol of ['\n', '\r\n']) for (const inline of [false, true]) {
// Scenario: HTML Comments Do Not Create Clause Groups
test(`HTML comments do not define groups: ${JSON.stringify(eol)}, inline=${inline}`, () => {
  const f = multiPairFixture('[Scenario: demo :: Retry after releasing the record] [WhenThen: 1]');
  try {
    const hidden = inline ? '<!-- - **WHEN** hidden - **THEN** hidden -->' : '<!--\n- **WHEN** hidden example\n- **THEN** hidden outcome\n-->';
    // These live bullets reach the clause predicate only after inline comments are removed.
    const visible = inline ? '\n<!-- inline boundary -->- **WHEN** visible example\n<!-- inline boundary -->- **THEN** visible outcome\n' : '';
    writeFileSync(f.spec, (readFileSync(f.spec, 'utf8') + '\n' + hidden + '\n' + visible).replace(/\r?\n/g, eol));
    assert.deepEqual(lintDeltaNewScenarioAssertionCoverage({ changeFolder: f.changeFolder, repoRoot: f.root }).warnings?.[0].missingGroups, inline ? [2, 3] : [2]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

}

// Scenario: Single-Pair Scenarios Keep Their Existing Result
test('Single-pair scenarios retain the existing successful result', () => {
  const f = buildTempChange({ scenarioTitle: 'Single pair boundary', withAssertingTest: true });
  try {
    assert.deepEqual(lintDeltaNewScenarioAssertionCoverage({ changeFolder: f.changeFolder, repoRoot: f.root }), { pass: true, violations: [] });
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

// Scenario: Unchanged Canonical Scenarios Need No New Mapping
test('Unchanged canonical multi-pair scenario does not require new mappings', () => {
  const f = multiPairFixture();
  try {
    assert.deepEqual(lintDeltaNewScenarioAssertionCoverage({ changeFolder: f.changeFolder, repoRoot: f.root }).warnings?.[0].missingGroups, [1, 2]);
    const content = readFileSync(f.spec, 'utf8').replace('## ADDED Requirements', '## MODIFIED Requirements');
    writeFileSync(f.spec, content);
    writeFileSync(join(f.root, 'openspec', 'specs', 'demo', 'spec.md'), content.replace('## MODIFIED Requirements', '# demo'));
    assert.deepEqual(lintDeltaNewScenarioAssertionCoverage({ changeFolder: f.changeFolder, repoRoot: f.root }), { pass: true, violations: [] });
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

// Scenario: Missing Carrier Still Blocks A Multi-Pair Scenario
test('Multi-pair scenario without a carrier keeps the blocking violation alongside warnings', () => {
  const f = multiPairFixture();
  try {
    rmSync(join(f.root, '.devpro', 'scripts', 'tests', 'coverage-fixture.test.mjs'));
    const result = lintDeltaNewScenarioAssertionCoverage({ changeFolder: f.changeFolder, repoRoot: f.root });
    assert.equal(result.pass, false);
    assert.deepEqual(result.violations, [{ cap: 'demo', mode: 'ADDED', title: f.title }]);
    assert.deepEqual(result.warnings?.[0].missingGroups, [1, 2]);
    const cli = spawnSync(process.execPath,
      [fileURLToPath(new URL('../lint-delta-new-scenario-assertion-coverage.mjs', import.meta.url)), f.changeFolder],
      { encoding: 'utf8' });
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /warning:.*WHEN\/THEN groups 1,2/);
    assert.match(cli.stderr, /has no asserting test\/lint fixture hit/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

for (const canonical of ['missing title', 'same title with only first group']) {
  test(`MODIFIED title eligibility is independent of canonical group count: ${canonical}`, () => {
    const f = multiPairFixture();
    try {
      const content = readFileSync(f.spec, 'utf8').replace('## ADDED Requirements', '## MODIFIED Requirements');
      writeFileSync(f.spec, content);
      const prior = canonical === 'missing title' ? content.replace(f.title, 'Unrelated canonical title') : content.replace('\n- **WHEN** retry leaves residue\n- **THEN** reject the retry\n', '');
      assert.notEqual(prior, content);
      writeFileSync(join(f.root, 'openspec', 'specs', 'demo', 'spec.md'), prior);
      const result = lintDeltaNewScenarioAssertionCoverage({ changeFolder: f.changeFolder, repoRoot: f.root });
      assert.equal(result.pass, true);
      assert.deepEqual(result.warnings?.[0].missingGroups, canonical === 'missing title' ? [1, 2] : undefined);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}
for (const marker of [
  '[Scenario: demo :: Retry after releasing the record][WhenThen: 1,2]',
  '[Scenario: demo :: Retry after releasing the record]  [WhenThen: 1,2]',
  '[Scenario: demo :: Retry after releasing the record] [WhenThen:1,2]',
  '[Scenario: demo :: Retry after releasing the record] [WhenThen:  1,2]',
]) {
  test(`malformed mapping spacing remains unmapped: ${marker}`, () => {
    const f = multiPairFixture(marker);
    try {
      const result = lintDeltaNewScenarioAssertionCoverage({ changeFolder: f.changeFolder, repoRoot: f.root });
      assert.equal(result.pass, true);
      assert.deepEqual(result.warnings?.[0].missingGroups, [1, 2]);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}
