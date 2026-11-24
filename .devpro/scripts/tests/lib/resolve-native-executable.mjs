import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';

function getEnvValue(env, name) {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

/**
 * Resolve a native executable for direct child-process spawning without shell
 * utilities such as `which`. Win32 searches executable image suffixes only;
 * `.cmd` and `.bat` files are not native spawn targets when shell is disabled.
 */
export function resolveNativeExecutableOnPath(name, env = process.env) {
  const pathValue = getEnvValue(env, 'PATH');
  const pathEntries = typeof pathValue === 'string' ? pathValue.split(path.delimiter) : [];
  const hasExtension = path.extname(name) !== '';
  const suffixes = process.platform === 'win32' && !hasExtension
    ? ['.exe', '.com']
    : [''];

  for (const entry of pathEntries) {
    const directory = entry.replace(/^"|"$/gu, '') || process.cwd();
    for (const suffix of suffixes) {
      const candidate = path.resolve(directory, `${name}${suffix}`);
      try {
        if (!statSync(candidate).isFile()) continue;
        if (process.platform !== 'win32') accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Continue searching the remaining PATH entries.
      }
    }
  }

  throw new Error(`Unable to resolve native executable "${name}" on PATH`);
}
