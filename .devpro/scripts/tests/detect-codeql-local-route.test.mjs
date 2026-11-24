import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  classifyStack,
  determineRoute,
  mapPlatform,
  probeLocalRoute,
  resolveExecutable,
  runCli,
} from '../detect-codeql-local-route.mjs';

const scriptPath = path.resolve('.devpro/scripts/detect-codeql-local-route.mjs');
const tempRoots = [];

function makeTempRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'codeql-route-'));
  tempRoots.push(root);
  return root;
}

function writeProject(root, relativePath, body) {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body);
}

function fakeFileLookup(existingPaths, platform = 'linux') {
  const normalize = platform === 'win32'
    ? (value) => value.replaceAll('/', '\\').toLowerCase()
    : (value) => value;
  const files = new Set(existingPaths.map(normalize));
  return (candidate) => files.has(normalize(candidate));
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop(), { recursive: true, force: true });
  }
});

describe('platform and executable detection', () => {
  it('maps Node platforms without invoking uname', () => {
    assert.equal(mapPlatform('darwin'), 'macos');
    assert.equal(mapPlatform('linux'), 'linux');
    assert.equal(mapPlatform('win32'), 'windows');
    assert.equal(mapPlatform('aix'), 'unknown');
  });

  it('resolves codeql.exe from win32 PATH and PATHEXT case-insensitively', () => {
    const executable = resolveExecutable('codeql', {
      platform: 'win32',
      env: { Path: 'C:\\Tools;D:\\Other', PATHEXT: '.COM;.EXE;.BAT;.CMD' },
      isFile: fakeFileLookup(['C:\\Tools\\CODEQL.EXE'], 'win32'),
    });

    assert.equal(executable?.toLowerCase(), 'c:\\tools\\codeql.exe');
  });

  it('resolves a POSIX executable from PATH without command-v or which', () => {
    assert.equal(resolveExecutable('codeql', {
      platform: 'linux',
      env: { PATH: '/opt/codeql/bin:/usr/bin' },
      isFile: fakeFileLookup(['/opt/codeql/bin/codeql']),
    }), '/opt/codeql/bin/codeql');
  });

  it('returns null when PATH has no CodeQL executable', () => {
    assert.equal(resolveExecutable('codeql', {
      platform: 'win32',
      env: { PATH: 'C:\\Tools', PATHEXT: '.EXE;.CMD' },
      isFile: () => false,
    }), null);
  });
});

describe('recursive stack classification', () => {
  it('classifies legacy ToolsVersion as Stack A and gives it priority', () => {
    const root = makeTempRoot();
    writeProject(root, 'src/sdk/sdk.csproj', '<Project Sdk="Microsoft.NET.Sdk"></Project>');
    writeProject(root, 'legacy/legacy.csproj', '<Project ToolsVersion="15.0"></Project>');

    assert.equal(classifyStack(root), 'A');
  });

  it('classifies SDK-style projects as Stack B', () => {
    const root = makeTempRoot();
    writeProject(root, 'src/app.csproj', '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>');

    assert.equal(classifyStack(root), 'B');
  });

  it('classifies direct child SDK elements as Stack B', () => {
    const fixtures = [
      '<Project><Sdk Name="Microsoft.NET.Sdk" /></Project>',
      "<Project>\n  <Sdk Version='8.0.100' Name='Microsoft.NET.Sdk.Web'></Sdk>\n</Project>",
      '<Project><Sdk Name="Microsoft.Build.NoTargets" /><Sdk Name="Microsoft.NET.Sdk" /></Project>',
      '<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003"><Sdk Name="Microsoft.NET.Sdk" /></Project>',
    ];

    for (const body of fixtures) {
      const root = makeTempRoot();
      writeProject(root, 'src/app.csproj', body);
      assert.equal(classifyStack(root), 'B', body);
    }
  });

  it('does not infer SDK style from comments, text, or nested SDK elements', () => {
    const root = makeTempRoot();
    writeProject(root, 'comment.csproj', '<Project><!-- <Sdk Name="Microsoft.NET.Sdk" /> --></Project>');
    writeProject(root, 'comment-root.csproj', '<!-- <Project Sdk="Microsoft.NET.Sdk"></Project> -->');
    writeProject(root, 'text.csproj', '<Project><Description><![CDATA[<Sdk Name="Microsoft.NET.Sdk" />]]></Description></Project>');
    writeProject(root, 'nested.csproj', '<Project><ItemGroup><Sdk Name="Microsoft.NET.Sdk" /></ItemGroup></Project>');

    assert.equal(classifyStack(root), 'C');
  });

  it('gives legacy ToolsVersion priority over direct child SDK elements', () => {
    const root = makeTempRoot();
    writeProject(root, 'src/sdk.csproj', '<Project><Sdk Name="Microsoft.NET.Sdk" /></Project>');
    writeProject(root, 'legacy/legacy.csproj', '<Project ToolsVersion="15.0"></Project>');

    assert.equal(classifyStack(root), 'A');
  });

  it('ignores generated and dependency directories', () => {
    const root = makeTempRoot();
    for (const directory of ['.git', 'node_modules', 'bin', 'obj', '.codeql-db', 'codeql-results']) {
      writeProject(root, `${directory}/ignored.csproj`, '<Project ToolsVersion="15.0"></Project>');
    }

    assert.equal(classifyStack(root), 'C');
  });

  it('classifies a repository without A/B project evidence as Stack C', () => {
    const root = makeTempRoot();
    writeFileSync(path.join(root, 'package.json'), '{}');

    assert.equal(classifyStack(root), 'C');
  });
});

describe('route matrix', () => {
  it('routes Windows Stack A with CLI to local', () => {
    assert.deepEqual(determineRoute({ platform: 'windows', stack: 'A', cliPresent: true }), {
      viability: 'viable', route: 'local', reason: 'local-viable',
    });
  });

  it('routes macOS and Linux Stack A to expected GHA fallback', () => {
    for (const platform of ['macos', 'linux']) {
      assert.deepEqual(determineRoute({ platform, stack: 'A', cliPresent: true }), {
        viability: 'not-viable', route: 'gha', reason: 'stack-a-requires-windows',
      });
    }
  });

  it('routes Stack B locally on all supported platforms when CLI is present', () => {
    for (const platform of ['windows', 'macos', 'linux']) {
      assert.deepEqual(determineRoute({ platform, stack: 'B', cliPresent: true }), {
        viability: 'viable', route: 'local', reason: 'local-viable',
      });
    }
  });

  it('routes Stack C to conservative GHA fallback', () => {
    assert.deepEqual(determineRoute({ platform: 'windows', stack: 'C', cliPresent: true }), {
      viability: 'undetermined', route: 'gha', reason: 'stack-undetermined',
    });
  });

  it('routes unknown platforms to conservative GHA fallback', () => {
    assert.deepEqual(determineRoute({ platform: 'unknown', stack: 'B', cliPresent: true }), {
      viability: 'undetermined', route: 'gha', reason: 'platform-unknown',
    });
  });

  it('routes a missing CLI to GHA regardless of otherwise viable stack', () => {
    assert.deepEqual(determineRoute({ platform: 'windows', stack: 'B', cliPresent: false }), {
      viability: 'viable', route: 'gha', reason: 'cli-missing',
    });
  });
});

describe('probe contract with injected host evidence', () => {
  it('routes element-form SDK projects locally with CLI and preserves the missing-CLI fallback', () => {
    const root = makeTempRoot();
    writeProject(root, 'app.csproj', '<Project><Sdk Name="Microsoft.NET.Sdk" /></Project>');
    const options = {
      root,
      platform: 'linux',
      env: { PATH: '/opt/codeql' },
      runVersion: () => ({ status: 0, stdout: 'CodeQL 2.20.0\n' }),
    };

    const withCli = probeLocalRoute({
      ...options,
      isFile: fakeFileLookup(['/opt/codeql/codeql']),
    });
    assert.equal(withCli.stack, 'B');
    assert.equal(withCli.route, 'local');

    const withoutCli = probeLocalRoute({ ...options, isFile: () => false });
    assert.equal(withoutCli.stack, 'B');
    assert.equal(withoutCli.route, 'gha');
    assert.equal(withoutCli.reason, 'cli-missing');
  });

  it('produces identical native Windows routing from distinct PowerShell and cmd environments', () => {
    const root = makeTempRoot();
    writeProject(root, 'legacy.csproj', '<Project ToolsVersion="15.0"></Project>');
    const fixtures = {
      powershell: {
        env: { Path: 'C:\\PowerShellTools;C:\\CodeQL', PATHEXT: '.PS1;.EXE' },
        executable: 'C:\\CodeQL\\codeql.exe',
      },
      cmd: {
        env: { PATH: 'C:\\CmdTools;D:\\CodeQL', Pathext: '.CMD;.EXE' },
        executable: 'D:\\CodeQL\\codeql.EXE',
      },
    };
    const probeFixture = ({ env, executable }, isFile = fakeFileLookup([executable], 'win32')) => {
      let invokedExecutable = null;
      const result = probeLocalRoute({
        root,
        platform: 'win32',
        env,
        isFile,
        runVersion: (candidate) => {
          invokedExecutable = candidate;
          return { status: 0, stdout: 'CodeQL command-line toolchain release 2.20.0\r\n' };
        },
      });
      return { invokedExecutable, result };
    };

    assert.notDeepEqual(fixtures.powershell, fixtures.cmd);
    const powershell = probeFixture(fixtures.powershell);
    const cmd = probeFixture(fixtures.cmd);
    assert.equal(powershell.invokedExecutable?.toLowerCase(), fixtures.powershell.executable.toLowerCase());
    assert.equal(cmd.invokedExecutable?.toLowerCase(), fixtures.cmd.executable.toLowerCase());
    assert.deepEqual(powershell.result, cmd.result);
    assert.equal(cmd.result.route, 'local');

    const missingCmdCli = probeFixture(fixtures.cmd, () => false);
    assert.notDeepEqual(powershell.result, missingCmdCli.result);
    assert.equal(missingCmdCli.result.reason, 'cli-missing');
  });

  it('keeps CLI present when bounded version lookup fails', () => {
    const root = makeTempRoot();
    writeProject(root, 'app.csproj', '<Project Sdk="Microsoft.NET.Sdk"></Project>');
    const result = probeLocalRoute({
      root,
      platform: 'linux',
      env: { PATH: '/opt/codeql' },
      isFile: fakeFileLookup(['/opt/codeql/codeql']),
      runVersion: () => ({ status: 1, stdout: '', stderr: 'version unavailable' }),
    });

    assert.equal(result.cliPresent, true);
    assert.equal(result.cliVersion, null);
    assert.equal(result.route, 'local');
  });

  it('emits all stable schema fields for CLI absence without side effects', () => {
    const root = makeTempRoot();
    writeProject(root, 'app.csproj', '<Project Sdk="Microsoft.NET.Sdk"></Project>');
    let versionCalls = 0;
    const result = probeLocalRoute({
      root,
      platform: 'darwin',
      env: { PATH: '' },
      isFile: () => false,
      runVersion: () => { versionCalls += 1; },
    });

    assert.deepEqual(Object.keys(result), [
      'schemaVersion', 'platform', 'cliPresent', 'cliVersion',
      'stack', 'viability', 'route', 'reason',
    ]);
    assert.deepEqual(result, {
      schemaVersion: 1,
      platform: 'macos',
      cliPresent: false,
      cliVersion: null,
      stack: 'B',
      viability: 'viable',
      route: 'gha',
      reason: 'cli-missing',
    });
    assert.equal(versionCalls, 0);
  });
});

describe('public CLI exit and stream contract', () => {
  it('writes exactly one JSON object to stdout for an expected fallback', () => {
    const root = makeTempRoot();
    writeFileSync(path.join(root, 'package.json'), '{}');
    const run = spawnSync(process.execPath, [scriptPath, '--root', root], {
      encoding: 'utf8',
      env: { ...process.env, PATH: '' },
    });

    assert.equal(run.status, 0);
    assert.equal(run.stderr, '');
    assert.equal(run.stdout.trim().split('\n').length, 1);
    const result = JSON.parse(run.stdout);
    assert.equal(result.route, 'gha');
    assert.equal(result.reason, 'cli-missing');
  });

  it('returns non-zero with bounded stderr and no JSON for an invalid root', () => {
    const run = spawnSync(process.execPath, [scriptPath, '--root', path.join(makeTempRoot(), 'missing')], {
      encoding: 'utf8',
    });

    assert.notEqual(run.status, 0);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /root.*readable directory/i);
    assert.ok(run.stderr.length <= 240);
  });

  it('returns non-zero with usage guidance for invalid arguments', () => {
    const run = spawnSync(process.execPath, [scriptPath, '--unknown'], { encoding: 'utf8' });

    assert.notEqual(run.status, 0);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /usage:/i);
    assert.ok(run.stderr.length <= 240);
  });

  it('returns an actionable bounded diagnostic without leaking unexpected failure details', () => {
    const root = makeTempRoot();
    let stdout = '';
    let stderr = '';
    const exitCode = runCli({
      argv: ['--root', root],
      probe: () => {
        throw new Error('EACCES: /Users/example/private/project.csproj owner@example.com');
      },
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
    });

    assert.equal(exitCode, 2);
    assert.equal(stdout, '');
    assert.match(stderr, /verify.*readable.*rerun/i);
    assert.doesNotMatch(stderr, /Users|project\.csproj|owner@example\.com|EACCES/i);
    assert.ok(stderr.length <= 240);
  });
});

describe('cross-carrier routing contract', () => {
  const probeCommand = 'node .devpro/scripts/detect-codeql-local-route.mjs --root .';
  const activeDeltaPath = 'openspec/changes/fix-codeql-native-windows-routing/specs/security-scanning/spec.md';
  const archivedDeltaPath = 'openspec/changes/archive/2026-07-14-fix-codeql-native-windows-routing/specs/security-scanning/spec.md';
  const deltaPath = existsSync(activeDeltaPath) ? activeDeltaPath : archivedDeltaPath;
  // Latest delta for all three requirements: the skill rename (`devpro:security-scan`).
  // Archive folder carries a date prefix, so resolve it by suffix after archive.
  const skillEntryActiveDeltaPath = 'openspec/changes/refactor-agent-skills-entry/specs/security-scanning/spec.md';
  const skillEntryArchivedFolder = readdirSync('openspec/changes/archive').find((name) => name.endsWith('-refactor-agent-skills-entry'));
  const skillEntryDeltaPath = existsSync(skillEntryActiveDeltaPath)
    ? skillEntryActiveDeltaPath
    : `openspec/changes/archive/${skillEntryArchivedFolder}/specs/security-scanning/spec.md`;
  const carrierPaths = [
    '.devpro/agent-rules/codeql-execution.md',
    '.devpro/agent-skills/security/security-scan/SKILL.md',
    'openspec/specs/security-scanning/spec.md',
    deltaPath,
  ];

  it('uses the same public probe command in every routing carrier', () => {
    for (const carrierPath of carrierPaths) {
      assert.match(readFileSync(carrierPath, 'utf8'), new RegExp(probeCommand.replaceAll('.', '\\.')));
    }
  });

  it('prompts only for local and skips the prompt for GHA in rule and skill', () => {
    for (const carrierPath of carrierPaths.slice(0, 2)) {
      const content = readFileSync(carrierPath, 'utf8');
      assert.match(content, /route="local"[^\n]*\[Y\/n\]/u);
      assert.match(content, /route="gha"[^\n]*(?:不 prompt|不要詢問)/u);
    }
  });

  it('removes POSIX-only executable routing snippets from rule and skill', () => {
    for (const carrierPath of carrierPaths.slice(0, 2)) {
      const content = readFileSync(carrierPath, 'utf8');
      assert.doesNotMatch(content, /command -v codeql|uname -s|grep -l/u);
    }
  });

  it('keeps all original scenarios and adds native Windows fallback coverage', () => {
    const delta = readFileSync(carrierPaths[3], 'utf8');
    const scenarioTitles = [
      'Stack A targets net4x and self-hosted Windows runner',
      'Stack B targets net5+ and may use ubuntu-latest',
      'Stack A disables MvcBuildViews before NuGet restore',
      'Local execution may bypass GHA workflow when viable',
      'Runner picks up within timeout permits proceed',
      'Timeout in queued state blocks scan',
      'Enumeration API is not used as a CI gate',
      'Local CLI detected first; queued-timeout reserved for GHA fallback',
      'Detection succeeds and viability passes; default y proceeds locally',
      'Stack A on macOS/Linux force-fallbacks without prompting',
      'User explicit `n` switches to GHA fallback',
      'CLI absent emits install hint with platform-universal URL fallback',
      'Native Windows shells share one probe contract',
      'Stack C remains undetermined and conservatively falls back',
      'Invalid root is a probe error, not a fallback',
    ];

    for (const title of scenarioTitles) {
      assert.match(delta, new RegExp(`^#### Scenario: ${title.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'mu'));
    }
    assert.equal((delta.match(/^#### Scenario:/gmu) ?? []).length, 15);
  });

  it('keeps each canonical requirement block byte-identical to its latest delta body', () => {
    const canonical = readFileSync(carrierPaths[2], 'utf8');
    const requirementDeltaPaths = new Map([
      ['Stack A/B/C Workflow Templates', skillEntryDeltaPath],
      ['Runner Readiness via Queued-Timeout Detection', skillEntryDeltaPath],
      ['Local-first Execution Path', skillEntryDeltaPath],
    ]);
    const extract = (content, title) => {
      const startMarker = `### Requirement: ${title}`;
      const start = content.indexOf(startMarker);
      assert.notEqual(start, -1);
      const next = content.indexOf('\n### Requirement:', start + startMarker.length);
      return content.slice(start, next === -1 ? content.length : next).trimEnd();
    };

    for (const [title, requirementDeltaPath] of requirementDeltaPaths) {
      const delta = readFileSync(requirementDeltaPath, 'utf8');
      assert.equal(extract(canonical, title), extract(delta, title));
    }
  });
});
