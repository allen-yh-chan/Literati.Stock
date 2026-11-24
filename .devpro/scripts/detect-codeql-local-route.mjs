#!/usr/bin/env node

import { accessSync, constants, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const IGNORED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'bin',
  'obj',
  '.codeql-db',
  'codeql-results',
]);

const USAGE = 'Usage: node .devpro/scripts/detect-codeql-local-route.mjs --root <directory>';
const UNEXPECTED_FAILURE = 'CodeQL route probe failed unexpectedly. Verify project files under --root are readable, then rerun the probe.';

export function mapPlatform(nodePlatform) {
  if (nodePlatform === 'darwin') return 'macos';
  if (nodePlatform === 'linux') return 'linux';
  if (nodePlatform === 'win32') return 'windows';
  return 'unknown';
}

function envValue(env, name, platform) {
  if (platform !== 'win32') return env[name];
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

function executableCandidates(command, platform, env) {
  const pathValue = envValue(env, 'PATH', platform) ?? '';
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const separator = platform === 'win32' ? ';' : ':';
  const directories = pathValue.split(separator).filter(Boolean);

  if (platform !== 'win32') {
    return directories.map((directory) => pathApi.join(directory, command));
  }

  const rawPathext = envValue(env, 'PATHEXT', platform) ?? '.COM;.EXE;.BAT;.CMD';
  const extensions = rawPathext
    .split(';')
    .filter(Boolean)
    .map((extension) => extension.startsWith('.') ? extension : `.${extension}`);
  const commandExtension = pathApi.extname(command);
  const names = commandExtension.length > 0
    ? [command]
    : extensions.map((extension) => `${command}${extension}`);

  return directories.flatMap((directory) => names.map((name) => pathApi.join(directory, name)));
}

function defaultIsExecutable(candidate, platform) {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveExecutable(command, {
  platform = process.platform,
  env = process.env,
  isFile = (candidate) => defaultIsExecutable(candidate, platform),
} = {}) {
  return executableCandidates(command, platform, env).find((candidate) => isFile(candidate)) ?? null;
}

function findTagEnd(content, start, terminator = '>') {
  let quote = null;
  for (let index = start; index < content.length; index += 1) {
    const character = content[index];
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (content.startsWith(terminator, index)) return index + terminator.length;
  }
  return content.length;
}

function findDeclarationEnd(content, start) {
  let quote = null;
  let subsetDepth = 0;
  for (let index = start; index < content.length; index += 1) {
    const character = content[index];
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '[') {
      subsetDepth += 1;
    } else if (character === ']') {
      subsetDepth = Math.max(0, subsetDepth - 1);
    } else if (character === '>' && subsetDepth === 0) {
      return index + 1;
    }
  }
  return content.length;
}

function parseAttributes(source) {
  const attributes = new Map();
  const pattern = /([A-Za-z_][\w:.-]*)\s*=\s*(["'])(.*?)\2/gsu;
  for (const match of source.matchAll(pattern)) {
    attributes.set(match[1].toLowerCase(), match[3]);
  }
  return attributes;
}

function inspectProject(content) {
  const stack = [];
  let legacy = false;
  let sdkStyle = false;

  for (let cursor = 0; cursor < content.length;) {
    const tagStart = content.indexOf('<', cursor);
    if (tagStart === -1) break;

    if (content.startsWith('<!--', tagStart)) {
      const commentEnd = content.indexOf('-->', tagStart + 4);
      cursor = commentEnd === -1 ? content.length : commentEnd + 3;
      continue;
    }
    if (content.startsWith('<![CDATA[', tagStart)) {
      const cdataEnd = content.indexOf(']]>', tagStart + 9);
      cursor = cdataEnd === -1 ? content.length : cdataEnd + 3;
      continue;
    }
    if (content.startsWith('<?', tagStart)) {
      cursor = findTagEnd(content, tagStart + 2, '?>');
      continue;
    }
    if (content.startsWith('<!', tagStart)) {
      cursor = findDeclarationEnd(content, tagStart + 2);
      continue;
    }

    const tagEnd = findTagEnd(content, tagStart + 1);
    const tag = content.slice(tagStart, tagEnd);
    const nameMatch = /^<\s*(\/?)\s*([A-Za-z_][\w:.-]*)/u.exec(tag);
    cursor = tagEnd;
    if (nameMatch === null) continue;

    const closing = nameMatch[1] === '/';
    const name = nameMatch[2].toLowerCase();
    if (closing) {
      if (stack.at(-1) === name) stack.pop();
      continue;
    }

    const selfClosing = /\/\s*>$/u.test(tag);
    const attributes = parseAttributes(tag.slice(nameMatch[0].length));
    if (stack.length === 0 && name === 'project') {
      legacy ||= attributes.has('toolsversion');
      sdkStyle ||= attributes.has('sdk');
    } else if (stack.length === 1 && stack[0] === 'project' && name === 'sdk') {
      sdkStyle ||= (attributes.get('name') ?? '').trim().length > 0;
    }

    if (!selfClosing) stack.push(name);
  }

  return { legacy, sdkStyle };
}

export function classifyStack(root, {
  listDirectory = (directory) => readdirSync(directory, { withFileTypes: true }),
  readText = (file) => readFileSync(file, 'utf8'),
} = {}) {
  let sdkStyleFound = false;
  const directories = [root];

  while (directories.length > 0) {
    const directory = directories.pop();
    for (const entry of listDirectory(directory)) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) {
          directories.push(path.join(directory, entry.name));
        }
        continue;
      }
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.csproj') continue;

      const content = readText(path.join(directory, entry.name));
      const evidence = inspectProject(content);
      if (evidence.legacy) return 'A';
      if (evidence.sdkStyle) sdkStyleFound = true;
    }
  }

  return sdkStyleFound ? 'B' : 'C';
}

export function determineRoute({ platform, stack, cliPresent }) {
  let viability;
  let viabilityReason;

  if (platform === 'unknown') {
    viability = 'undetermined';
    viabilityReason = 'platform-unknown';
  } else if (stack === 'C') {
    viability = 'undetermined';
    viabilityReason = 'stack-undetermined';
  } else if (stack === 'A' && platform !== 'windows') {
    viability = 'not-viable';
    viabilityReason = 'stack-a-requires-windows';
  } else {
    viability = 'viable';
    viabilityReason = 'local-viable';
  }

  if (!cliPresent) return { viability, route: 'gha', reason: 'cli-missing' };
  if (viability !== 'viable') return { viability, route: 'gha', reason: viabilityReason };
  return { viability, route: 'local', reason: 'local-viable' };
}

function defaultRunVersion(executable) {
  return spawnSync(executable, ['--version'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024,
    shell: false,
    timeout: 3000,
    windowsHide: true,
  });
}

function versionFrom(result) {
  if (result?.status !== 0 || typeof result.stdout !== 'string') return null;
  const firstLine = result.stdout.split(/\r?\n/u).find((line) => line.trim().length > 0);
  return firstLine === undefined ? null : firstLine.trim().replace(/\s+/gu, ' ').slice(0, 160);
}

export function probeLocalRoute({
  root,
  platform = process.platform,
  env = process.env,
  isFile,
  runVersion = defaultRunVersion,
  classify = classifyStack,
}) {
  const executable = resolveExecutable('codeql', { platform, env, isFile });
  const cliPresent = executable !== null;
  const cliVersion = cliPresent ? versionFrom(runVersion(executable)) : null;
  const mappedPlatform = mapPlatform(platform);
  const stack = classify(root);
  const routing = determineRoute({ platform: mappedPlatform, stack, cliPresent });

  return {
    schemaVersion: 1,
    platform: mappedPlatform,
    cliPresent,
    cliVersion,
    stack,
    viability: routing.viability,
    route: routing.route,
    reason: routing.reason,
  };
}

function parseArguments(argv) {
  if (argv.length !== 2 || argv[0] !== '--root' || argv[1].length === 0) {
    throw new Error(USAGE);
  }
  return argv[1];
}

function validateRoot(root) {
  try {
    if (!statSync(root).isDirectory()) throw new Error('not-directory');
    accessSync(root, constants.R_OK);
  } catch {
    throw new Error('Invalid root: expected a readable directory.');
  }
}

export function runCli({
  argv = process.argv.slice(2),
  probe = probeLocalRoute,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  try {
    const root = parseArguments(argv);
    validateRoot(root);
    stdout.write(`${JSON.stringify(probe({ root }))}\n`);
    return 0;
  } catch (error) {
    const expected = error instanceof Error && (error.message === USAGE || error.message.startsWith('Invalid root:'));
    stderr.write(`${expected ? error.message : UNEXPECTED_FAILURE}\n`);
    return 2;
  }
}

const invokedPath = process.argv[1] === undefined ? '' : path.resolve(process.argv[1]);
if (fileURLToPath(import.meta.url) === invokedPath) process.exitCode = runCli();
